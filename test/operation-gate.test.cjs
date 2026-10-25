const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function load(imports = {}) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(require.resolve("../src/modules/OperationGate.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports,
      require(id) {
        assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
        return imports[id];
      },
    },
  );
  return exports;
}

const notices = [];
const gate = load({
  "../utils/locale": { getString: (key) => key },
  "../utils/utils": {
    Utils: { showPopWin: (t, m, type) => notices.push({ t, m, type }) },
  },
});

test("a second operation is refused while the first is running", async () => {
  notices.length = 0;
  let running = 0;
  let overlapped = false;

  let release;
  const first = gate.runExclusive(async () => {
    running++;
    await new Promise((r) => {
      release = r;
    });
    running--;
  });

  // Give the first task a tick to enter.
  await new Promise((r) => setImmediate(r));

  const second = await gate.runExclusive(async () => {
    if (running > 0) overlapped = true;
  });

  release();
  await first;

  assert.equal(second, false, "second call should be refused");
  assert.equal(overlapped, false, "second task must not run concurrently");
  assert.equal(notices.length, 1, "user is told the plugin is busy");
});

test("the lock is released when the task throws", async () => {
  await assert.rejects(
    gate.runExclusive(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(gate.isPluginBusy(), false);

  let ran = false;
  const ok = await gate.runExclusive(async () => {
    ran = true;
  });
  assert.equal(ok, true);
  assert.equal(ran, true);
});
