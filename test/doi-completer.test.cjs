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
const {
  normalizeTitle,
  titleSimilarity,
  selectBestDOI,
  formatArXivDOI,
  TITLE_SIMILARITY_THRESHOLD,
  STRICT_TITLE_SIMILARITY_THRESHOLD,
} = loadModule(`${root}/src/modules/DOICompleter.ts`);

const CANDIDATE = {
  DOI: "10.1000/attention",
  title: ["Attention Is All You Need"],
  author: [{ family: "Vaswani" }, { family: "Shazeer" }],
  issued: { "date-parts": [[2017]] },
};

test("normalizeTitle strips case, punctuation, markup, and diacritics", () => {
  assert.equal(normalizeTitle("  Déjà-Vu:  A  Study! "), "deja vu a study");
  assert.equal(normalizeTitle("<i>Nature</i> of Things"), "nature of things");
});

test("titleSimilarity is 1 for identical normalized titles and 0 for empty", () => {
  assert.equal(titleSimilarity("Hello, World", "hello   world"), 1);
  assert.equal(titleSimilarity("", "anything"), 0);
});

test("selectBestDOI accepts a strong title + year + author match", () => {
  const query = {
    title: "attention is all you need",
    year: 2017,
    authorSurname: "Vaswani",
  };
  assert.equal(selectBestDOI(query, [CANDIDATE])?.doi, "10.1000/attention");
});

test("selectBestDOI tolerates a one-year drift", () => {
  const query = {
    title: "attention is all you need",
    year: 2018,
    authorSurname: "Vaswani",
  };
  assert.equal(selectBestDOI(query, [CANDIDATE])?.doi, "10.1000/attention");
});

test("selectBestDOI rejects when the year is off by more than one", () => {
  const query = {
    title: "attention is all you need",
    year: 2010,
    authorSurname: "Vaswani",
  };
  assert.equal(selectBestDOI(query, [CANDIDATE]), null);
});

test("selectBestDOI rejects an unrelated title", () => {
  const query = {
    title: "a completely unrelated paper about tree frogs",
    year: 2017,
    authorSurname: "Vaswani",
  };
  assert.equal(selectBestDOI(query, [CANDIDATE]), null);
});

test("selectBestDOI rejects when the author disagrees", () => {
  const query = {
    title: "attention is all you need",
    year: null,
    authorSurname: "Einstein",
  };
  assert.equal(selectBestDOI(query, [CANDIDATE]), null);
});

test("selectBestDOI accepts an exact title even without year or author", () => {
  const query = {
    title: "attention is all you need",
    year: null,
    authorSurname: null,
  };
  assert.equal(
    selectBestDOI(query, [
      { DOI: "10.1/x", title: ["Attention is all you need"] },
    ])?.doi,
    "10.1/x",
  );
});

test("selectBestDOI is strict about title when nothing corroborates", () => {
  const query = {
    title: "attention is all you need",
    year: null,
    authorSurname: null,
  };
  // One-character difference: above the base bar, below the strict bar.
  const variant = "attention is all you feed";
  const sim = titleSimilarity(query.title, variant);
  assert.ok(sim >= TITLE_SIMILARITY_THRESHOLD, `similarity was ${sim}`);
  assert.ok(sim < STRICT_TITLE_SIMILARITY_THRESHOLD, `similarity was ${sim}`);

  // No year/author to corroborate the sub-strict title → rejected.
  assert.equal(
    selectBestDOI(query, [{ DOI: "10.1/x", title: [variant] }]),
    null,
  );
  // The very same title is accepted once a matching year corroborates it.
  assert.equal(
    selectBestDOI({ ...query, year: 2017 }, [
      { DOI: "10.1/x", title: [variant], issued: { "date-parts": [[2017]] } },
    ])?.doi,
    "10.1/x",
  );
});

test("selectBestDOI picks the highest-similarity candidate", () => {
  const query = {
    title: "attention is all you need",
    year: 2017,
    authorSurname: "Vaswani",
  };
  const doi = selectBestDOI(query, [
    {
      DOI: "10.1/near",
      title: ["attention is all you feed"],
      author: [{ family: "Vaswani" }],
      issued: { "date-parts": [[2017]] },
    },
    CANDIDATE,
  ])?.doi;
  assert.equal(doi, "10.1000/attention");
});

test("selectBestDOI skips candidates without a DOI or title", () => {
  const query = {
    title: "attention is all you need",
    year: 2017,
    authorSurname: "Vaswani",
  };
  assert.equal(
    selectBestDOI(query, [
      { title: ["Attention is all you need"] },
      { DOI: "10.1/no-title" },
    ]),
    null,
  );
});

test("normalizeTitle preserves Unicode letters such as Chinese and Greek", () => {
  assert.equal(
    normalizeTitle(" 基于区块链智能合约的建筑工程！ "),
    "基于区块链智能合约的建筑工程",
  );
  assert.equal(
    normalizeTitle("β-amyloid and α-synuclein"),
    "β amyloid and α synuclein",
  );
});

test("formatArXivDOI produces standard DataCite DOI and strips version suffix", () => {
  assert.equal(formatArXivDOI("2405.01171v2"), "10.48550/arXiv.2405.01171");
  assert.equal(
    formatArXivDOI("cond-mat/9805244v1"),
    "10.48550/arXiv.cond-mat/9805244",
  );
});

test("selectBestDOI accepts high-confidence match when subtitle was omitted", () => {
  const query = {
    title: "Pedestrian route choice and activity scheduling: theory and models",
    year: 2003,
    authorSurname: "Hoogendoorn",
  };
  const candidate = {
    DOI: "10.1016/S0191-2615(03)00007-9",
    title: ["Pedestrian route choice and activity scheduling"],
    author: [{ family: "Hoogendoorn" }],
    issued: { "date-parts": [[2003]] },
  };
  assert.equal(
    selectBestDOI(query, [candidate])?.doi,
    "10.1016/S0191-2615(03)00007-9",
  );
});
