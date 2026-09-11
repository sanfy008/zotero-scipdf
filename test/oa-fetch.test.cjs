const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { URL } = require("node:url");
const ts = require("typescript");

function load(path, imports = {}, globals = {}) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { exports, require: (id) => imports[id], URL, ...globals },
  );
  return exports;
}

const identifiers = load("../src/utils/identifierPatterns.ts");
const { Utils } = load("../src/utils/utils.ts", {
  "./identifierPatterns": identifiers,
});
// Use the real landing-page extractor so the flow test exercises it end to end.
const realOA = load("../src/modules/OAResolver.ts", {
  "../utils/prefs": { getPref: () => undefined },
  "./DOICompleter": {
    titleSimilarity: () => 1,
    TITLE_SIMILARITY_THRESHOLD: 0.9,
  },
});

const item = (doi = "10.1002/atr.1396") => ({
  isRegularItem: () => true,
  getDisplayTitle: () => "Test article",
  getField: (field) => (field === "DOI" ? doi : ""),
  getBestAttachments: async () => [],
});

function harness({
  candidates = [],
  landingHtml = {},
  attachFails = false,
  scihubEnabled = false,
} = {}) {
  const windows = [];
  const calls = [];
  const imports = [];
  const ui = {
    ...Utils,
    extractDOIs: Utils.extractDOIs,
    extractArXivIDs: Utils.extractArXivIDs,
    attachRemotePDF: async (url) => {
      if (attachFails) throw new Error("import failed");
      imports.push(url.href);
    },
    showPopWin: (title, text, type, closeTime) => {
      const w = {
        title,
        closeTime,
        closed: false,
        updates: [],
        addDescription() {},
        changeLine(line) {
          this.updates.push(line);
        },
      };
      w.win = {
        close() {
          w.closed = true;
        },
      };
      windows.push(w);
      return w;
    },
  };
  const { SciHubFetcher } = load(
    "../src/modules/SciHubFetcher.ts",
    {
      "../utils/locale": {
        getString: (key, options) =>
          options ? JSON.stringify(options.args) : key,
      },
      "../utils/utils": { Utils: ui },
      "../utils/prefs": {
        getPref: (key) => {
          if (key === "scihubEnabled") return scihubEnabled;
          if (key === "completeDOI") return false;
          if (key === "email") return "test@example.com";
          return true; // unpaywall / semanticScholar / openAlex
        },
      },
      "./DOICompleter": {
        findDOI: async () => null,
        doiExists: async () => true,
        formatArXivDOI: (id) => `10.48550/arXiv.${id}`,
      },
      "./OAResolver": {
        OAResolver: { resolve: async () => candidates },
        extractPdfUrlFromHtml: realOA.extractPdfUrlFromHtml,
      },
      "./CustomResolverManager": {
        CustomResolverManager: { shared: { customResolvers: [] } },
      },
    },
    {
      Zotero: {
        debug() {},
        HTTP: {
          request: async (method, url) => {
            calls.push(url);
            const html = landingHtml[url];
            return {
              status: html === undefined ? 404 : 200,
              statusText: String(html === undefined ? 404 : 200),
              responseText: html || "",
            };
          },
        },
      },
      ztoolkit: { log() {} },
    },
  );
  return {
    run: (items) => SciHubFetcher.updateItems(items, false),
    windows,
    calls,
    imports,
  };
}

test("a direct OA PDF candidate is attached and reported as success", async () => {
  const h = harness({
    candidates: [
      { url: "https://repo.example/a.pdf", kind: "pdf", source: "Unpaywall" },
    ],
  });
  await h.run([item()]);
  assert.deepEqual(h.imports, ["https://repo.example/a.pdf"]);
  assert.equal(h.calls.length, 0); // attach is mocked; no landing fetch needed
  assert.equal(h.windows.at(-1).title, "popwin-fetchsuccess");
});

test("a landing candidate is scraped for citation_pdf_url, then attached", async () => {
  const landing = "https://journal.example/article/1";
  const h = harness({
    candidates: [{ url: landing, kind: "landing", source: "OpenAlex" }],
    landingHtml: {
      [landing]:
        '<meta name="citation_pdf_url" content="https://journal.example/pdf/1.pdf">',
    },
  });
  await h.run([item()]);
  assert.deepEqual(h.calls, [landing]);
  assert.deepEqual(h.imports, ["https://journal.example/pdf/1.pdf"]);
  assert.equal(h.windows.at(-1).title, "popwin-fetchsuccess");
});

test("no OA candidates with Sci-Hub off reports PDF not available", async () => {
  const h = harness({ candidates: [] });
  await h.run([item()]);
  assert.equal(h.imports.length, 0);
  assert.equal(h.windows.at(-1).title, "popwin-pdfnotavaliable");
});

test("a candidate that fails to download reports failure, not unavailable", async () => {
  const h = harness({
    candidates: [
      { url: "https://repo.example/a.pdf", kind: "pdf", source: "Unpaywall" },
    ],
    attachFails: true,
  });
  await h.run([item()]);
  assert.equal(h.imports.length, 0);
  assert.equal(h.windows.at(-1).title, "popwin-fetchfailed");
});

test("a landing page with no PDF hint falls through to not available", async () => {
  const landing = "https://journal.example/article/2";
  const h = harness({
    candidates: [{ url: landing, kind: "landing", source: "OpenAlex" }],
    landingHtml: { [landing]: "<html><body>abstract only</body></html>" },
  });
  await h.run([item()]);
  assert.equal(h.imports.length, 0);
  // We had a candidate but extracted no PDF → treated as a failed download.
  assert.equal(h.windows.at(-1).title, "popwin-fetchfailed");
});
