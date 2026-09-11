const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function loadModule(file, imports = {}, globals = {}) {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  runInNewContext(outputText, {
    exports,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
      return imports[id];
    },
    ...globals,
  });
  return exports;
}

const root = dirname(require.resolve("../package.json"));

test("DOIManager executes batch audit, updates items, and produces summary", async () => {
  const winLines = [];
  const popwins = [];

  const fakeWin = {
    changeLine: (line) => winLines.push(line),
    show: () => {},
  };

  const fakeUtils = {
    showPopWin: (title, message, type, closeTime) => {
      popwins.push({ title, message, type, closeTime });
      return fakeWin;
    },
  };

  const fakeLocale = {
    getString: (key, options) => {
      if (options?.args?.total) {
        return `Audit ${options.args.total} items: ${options.args.valid} valid, ${options.args.repaired} repaired, ${options.args.failed} failed`;
      }
      return key;
    },
  };

  const fakeCompleter = {
    verifyAndRepairItemDOI: async (item) => {
      if (item.id === 1) {
        return { outcome: "valid", oldDOI: "10.1002/atr.1396", newDOI: "10.1002/atr.1396" };
      }
      if (item.id === 2) {
        return {
          outcome: "repaired",
          detail: "mismatched",
          oldDOI: "10.1016/wrong.doi",
          newDOI: "10.1057/right.doi",
        };
      }
      return { outcome: "unresolved", message: "Not found" };
    },
  };

  const fakeZotero = {
    Prefs: {
      get: () => "sanfy007@gmail.com",
    },
    debug: () => {},
  };

  const managerModule = loadModule(
    `${root}/src/modules/DOIManager.ts`,
    {
      "../utils/locale": fakeLocale,
      "../utils/utils": { Utils: fakeUtils },
      "./DOICompleter": fakeCompleter,
    },
    { Zotero: fakeZotero },
  );

  const items = [
    { id: 1, isRegularItem: () => true, getDisplayTitle: () => "Valid Paper" },
    { id: 2, isRegularItem: () => true, getDisplayTitle: () => "Mismatched Paper" },
    { id: 3, isRegularItem: () => true, getDisplayTitle: () => "Missing Paper" },
  ];

  await managerModule.DOIManager.auditAndRepairItems(items);

  // Check that progress lines were reported
  assert.equal(winLines.length, 4); // 3 items + 1 summary
  assert.ok(winLines[0].text.includes("(1/3)"));
  assert.ok(winLines[1].text.includes("(2/3)"));
  assert.ok(winLines[2].text.includes("(3/3)"));

  // Check that summary was written to window line
  const summaryLine = winLines[3];
  assert.ok(summaryLine.text.includes("3 items: 1 valid, 1 repaired, 1 failed"));
  assert.equal(summaryLine.type, "success");

  // Check popwins
  const successPops = popwins.filter((p) => p.type === "success");
  assert.equal(successPops.length, 1);
  assert.ok(successPops[0].message.includes("10.1016/wrong.doi → 10.1057/right.doi"));
});
