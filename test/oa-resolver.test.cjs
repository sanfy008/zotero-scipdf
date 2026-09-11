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

const {
  parseUnpaywall,
  parseSemanticScholar,
  parseOpenAlexOA,
  parseArXivFeed,
  buildArXivDirectCandidate,
  orderCandidates,
  extractPdfUrlFromHtml,
} = load("../src/modules/OAResolver.ts", {
  "../utils/prefs": { getPref: () => undefined },
  "./DOICompleter": {
    titleSimilarity: (a, b) => (a.toLowerCase() === b.toLowerCase() ? 1 : 0),
    TITLE_SIMILARITY_THRESHOLD: 0.9,
  },
});

// Parser results are built inside the VM realm, so their prototype differs from
// the test realm's. Round-trip through JSON before deep-equality (same approach
// as startup-preferences.test.cjs).
const j = (value) => JSON.parse(JSON.stringify(value));

test("parseUnpaywall surfaces best_oa_location pdf and landing", () => {
  const out = parseUnpaywall({
    best_oa_location: {
      url_for_pdf: "https://repo.example/a.pdf",
      url: "https://repo.example/landing",
    },
    oa_locations: [{ url_for_pdf: "https://mirror.example/b.pdf" }],
  });
  assert.deepEqual(j(out), [
    { url: "https://repo.example/a.pdf", kind: "pdf", source: "Unpaywall" },
    {
      url: "https://repo.example/landing",
      kind: "landing",
      source: "Unpaywall",
    },
    { url: "https://mirror.example/b.pdf", kind: "pdf", source: "Unpaywall" },
  ]);
});

test("parseUnpaywall tolerates a closed record with no locations", () => {
  assert.deepEqual(j(parseUnpaywall({ is_oa: false, best_oa_location: null })), []);
  assert.deepEqual(j(parseUnpaywall(null)), []);
});

test("parseSemanticScholar reads openAccessPdf.url", () => {
  assert.deepEqual(
    j(parseSemanticScholar({ openAccessPdf: { url: "https://s2.example/x.pdf" } })),
    [{ url: "https://s2.example/x.pdf", kind: "pdf", source: "Semantic Scholar" }],
  );
  assert.deepEqual(j(parseSemanticScholar({ openAccessPdf: null })), []);
});

test("parseSemanticScholar extracts arXiv ID from externalIds", () => {
  const out = parseSemanticScholar({
    externalIds: { ArXiv: "2405.01171v2" },
  });
  assert.deepEqual(j(out), [
    {
      url: "https://arxiv.org/pdf/2405.01171.pdf",
      kind: "pdf",
      source: "Semantic Scholar (arXiv)",
    },
  ]);
});

test("buildArXivDirectCandidate produces direct PDF link", () => {
  const cand = buildArXivDirectCandidate("2405.01171");
  assert.deepEqual(j(cand), {
    url: "https://arxiv.org/pdf/2405.01171.pdf",
    kind: "pdf",
    source: "arXiv",
  });
});

test("parseArXivFeed extracts entries and maps to direct PDF", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1105.2152v1</id>
    <title>How simple rules determine pedestrian behavior and crowd disasters</title>
    <link title="pdf" href="http://arxiv.org/pdf/1105.2152v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;
  const out = parseArXivFeed(xml, "How simple rules determine pedestrian behavior and crowd disasters");
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://arxiv.org/pdf/1105.2152v1.pdf");
  assert.equal(out[0].source, "arXiv (Preprint)");
});

test("parseOpenAlexOA collects pdf_url, landing, and oa_url", () => {
  const out = parseOpenAlexOA({
    best_oa_location: {
      pdf_url: null,
      landing_page_url: "https://oa.example/landing",
    },
    locations: [
      { pdf_url: "https://oa.example/direct.pdf" },
      { pdf_url: null, landing_page_url: "https://oa.example/other" },
    ],
    open_access: { oa_url: "https://oa.example/gold" },
  });
  assert.deepEqual(j(out), [
    { url: "https://oa.example/landing", kind: "landing", source: "OpenAlex" },
    { url: "https://oa.example/direct.pdf", kind: "pdf", source: "OpenAlex" },
    { url: "https://oa.example/other", kind: "landing", source: "OpenAlex" },
    { url: "https://oa.example/gold", kind: "landing", source: "OpenAlex" },
  ]);
});

test("orderCandidates puts PDFs first and de-duplicates by URL", () => {
  const out = orderCandidates([
    { url: "https://x/landing", kind: "landing", source: "A" },
    { url: "https://x/a.pdf", kind: "pdf", source: "A" },
    { url: "https://x/a.pdf", kind: "pdf", source: "B" }, // dup
    { url: "https://x/b.pdf", kind: "pdf", source: "C" },
  ]);
  assert.deepEqual(j(out), [
    { url: "https://x/a.pdf", kind: "pdf", source: "A" },
    { url: "https://x/b.pdf", kind: "pdf", source: "C" },
    { url: "https://x/landing", kind: "landing", source: "A" },
  ]);
});

test("extractPdfUrlFromHtml finds citation_pdf_url regardless of attribute order", () => {
  const base = "https://journal.example/article/123";
  assert.equal(
    extractPdfUrlFromHtml(
      '<meta name="citation_pdf_url" content="https://journal.example/pdf/123.pdf">',
      base,
    ),
    "https://journal.example/pdf/123.pdf",
  );
  assert.equal(
    extractPdfUrlFromHtml(
      '<meta content="/pdf/123.pdf" name="citation_pdf_url">',
      base,
    ),
    "https://journal.example/pdf/123.pdf",
  );
});

test("extractPdfUrlFromHtml falls back to an application/pdf link", () => {
  assert.equal(
    extractPdfUrlFromHtml(
      '<link rel="alternate" type="application/pdf" href="https://r.example/f.pdf">',
      "https://r.example/",
    ),
    "https://r.example/f.pdf",
  );
});

test("extractPdfUrlFromHtml returns null when no PDF hint is present", () => {
  assert.equal(
    extractPdfUrlFromHtml("<html><body>no pdf here</body></html>", "https://x/"),
    null,
  );
  assert.equal(extractPdfUrlFromHtml("", "https://x/"), null);
});
