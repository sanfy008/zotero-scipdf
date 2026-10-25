const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { URL } = require("node:url");
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
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id.endsWith("/constants")) return { API_USER_AGENT: "test" };
      assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
      return imports[id];
    },
    ...globals,
  });
  return exports;
}

const root = require("node:path").dirname(require.resolve("../package.json"));
const identifiers = loadModule(`${root}/src/utils/identifierPatterns.ts`);
const completer = loadModule(`${root}/src/modules/DOICompleter.ts`, {
  "../utils/identifierPatterns": identifiers,
  "../utils/utils": { Utils: {} },
});

// --- fixtures -------------------------------------------------------------
let nextId = 1;
function makeItem({ title = "", doi = "", extra = "", url = "", pdf = null }) {
  const id = nextId++;
  const fields = { title, DOI: doi, extra, url };
  return {
    id,
    libraryID: 1,
    deleted: false,
    isRegularItem: () => true,
    isPDFAttachment: () => Boolean(pdf),
    getField: (f) => fields[f] || "",
    getAttachments: () => (pdf ? [attachmentOf(id).id] : []),
    getFilePath: pdf ? () => pdf : undefined,
    _pdf: pdf,
  };
}
const attachmentRegistry = new Map();
const attachmentPath = new Map();
function attachmentOf(parentId) {
  const id = 10000 + parentId;
  const att = {
    id,
    parentItemID: parentId,
    deleted: false,
    isRegularItem: () => false,
    isPDFAttachment: () => true,
    getField: () => "",
    getFilePath: () => attachmentPath.get(id) || `C:/pdfs/${parentId}.pdf`,
  };
  attachmentRegistry.set(id, att);
  return att;
}

function buildIndex(libraryItems) {
  const parentIds = [];
  for (const item of libraryItems) {
    if (item._pdf) {
      const att = attachmentOf(item.id);
      attachmentPath.set(att.id, item._pdf);
      item.getAttachments = () => [att.id];
      parentIds.push(att.id);
    }
  }
  const Zotero = {
    Items: {
      getAll: async () => libraryItems,
      get: (id) => attachmentRegistry.get(id),
    },
    debug: () => {},
  };
  const { LocalPDFIndex } = loadModule(
    `${root}/src/modules/LocalPDFIndex.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "./DOICompleter": completer,
    },
    { Zotero },
  );
  return LocalPDFIndex.build(1);
}

// --- tests ---------------------------------------------------------------
test("indexes only items that have a PDF attachment", async () => {
  const withPdf = makeItem({ title: "A paper", pdf: "C:/a.pdf" });
  const withoutPdf = makeItem({ title: "Another paper" });
  const index = await buildIndex([withPdf, withoutPdf]);
  assert.equal(index.size, 1);
});

test("matches by DOI and reports the evidence", async () => {
  const owner = makeItem({
    title: "Owner",
    doi: "10.1000/abc",
    pdf: "C:/a.pdf",
  });
  const index = await buildIndex([owner]);
  const target = makeItem({ title: "Different title", doi: "10.1000/ABC" });
  const match = index.find(target);
  assert.ok(match);
  assert.equal(match.evidence, "doi");
  assert.equal(match.parent.id, owner.id);
  assert.equal(match.filePath, "C:/a.pdf");
});

test("never matches an item against its own attachment", async () => {
  const owner = makeItem({
    title: "Same",
    doi: "10.1000/abc",
    pdf: "C:/a.pdf",
  });
  const index = await buildIndex([owner]);
  assert.equal(index.find(owner), null);
});

test("matches by arXiv id carried in extra", async () => {
  const owner = makeItem({
    title: "Preprint",
    extra: "arXiv:1706.03762",
    pdf: "C:/p.pdf",
  });
  const index = await buildIndex([owner]);
  const target = makeItem({
    title: "Some other rendering",
    extra: "arXiv:1706.03762v3",
  });
  const match = index.find(target);
  assert.ok(match);
  assert.equal(match.evidence, "arxiv");
});

test("title fallback matches a near-identical title", async () => {
  const owner = makeItem({
    title: "Street network or functional attractors in pedestrian movement",
    pdf: "C:/s.pdf",
  });
  const index = await buildIndex([owner]);
  const target = makeItem({
    title: "Street network or functional attractors in pedestrian movement.",
  });
  const match = index.find(target);
  assert.ok(match);
  assert.equal(match.evidence, "title");
});

test("title fallback rejects an ambiguous pair", async () => {
  // Two very similar titles: silently picking either could attach the wrong
  // paper to the reference.
  const a = makeItem({
    title: "Pedestrian movement patterns in urban form",
    pdf: "C:/1.pdf",
  });
  const b = makeItem({
    title: "Pedestrian movement patterns in urban forms",
    pdf: "C:/2.pdf",
  });
  const index = await buildIndex([a, b]);
  const target = makeItem({
    title: "Pedestrian movement patterns in urban form",
  });
  assert.equal(index.find(target), null);
});

test("title fallback ignores unrelated titles", async () => {
  const owner = makeItem({ title: "A study of tree frogs", pdf: "C:/t.pdf" });
  const index = await buildIndex([owner]);
  const target = makeItem({
    title: "Space syntax and pedestrian route choice",
  });
  assert.equal(index.find(target), null);
});
