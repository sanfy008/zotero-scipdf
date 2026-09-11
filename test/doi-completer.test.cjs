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
const identifiers = loadModule(`${root}/src/utils/identifierPatterns.ts`);
const { Utils } = loadModule(`${root}/src/utils/utils.ts`, {
  "./identifierPatterns": identifiers,
});

const fakeZotero = {
  debug: () => {},
  HTTP: {
    request: async () => ({ status: 404 }),
  },
};

const completerModule = loadModule(
  `${root}/src/modules/DOICompleter.ts`,
  {
    "../utils/identifierPatterns": identifiers,
    "../utils/utils": { Utils },
  },
  { Zotero: fakeZotero },
);

const {
  normalizeTitle,
  titleSimilarity,
  selectBestDOI,
  formatArXivDOI,
  cleanQueryTitle,
  recordDOIAudit,
  verifyDOI,
  verifyAndRepairItemDOI,
  TITLE_SIMILARITY_THRESHOLD,
  STRICT_TITLE_SIMILARITY_THRESHOLD,
} = completerModule;

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
  assert.equal(selectBestDOI(query, [CANDIDATE])?.doi, "10.1000/attention");
});

test("selectBestDOI is strict about title when nothing corroborates", () => {
  const candidate = {
    DOI: "10.1000/attention-variant",
    title: ["Attention Is Almost All You Need"],
  };
  const query = {
    title: "attention is all you need",
    year: null,
    authorSurname: null,
  };
  assert.equal(selectBestDOI(query, [candidate]), null);
});

test("selectBestDOI picks the highest-similarity candidate", () => {
  const query = {
    title: "attention is all you need",
    year: 2017,
    authorSurname: "Vaswani",
  };
  const doi = selectBestDOI(query, [
    {
      DOI: "10.1000/worse",
      title: ["Attention is partially what you need"],
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

test("cleanQueryTitle strips punctuation and collapses whitespace", () => {
  assert.equal(
    cleanQueryTitle("Street network or functional attractors? Capturing pedestrian movement patterns"),
    "Street network or functional attractors Capturing pedestrian movement patterns",
  );
  assert.equal(
    cleanQueryTitle("<i>Attention</i>: Is It All You Need?"),
    "Attention Is It All You Need",
  );
});

test("recordDOIAudit appends timestamped entry to extra field without overwriting", () => {
  let extraContent = "PMID: 123456";
  let tags = [];
  const fakeItem = {
    getField: (f) => (f === "extra" ? extraContent : ""),
    setField: (f, v) => {
      if (f === "extra") extraContent = v;
    },
    addTag: (t) => tags.push(t),
  };

  recordDOIAudit(fakeItem, "10.1057/fake.bad", "10.1057/real.good", "404 not found");
  assert.ok(extraContent.includes("PMID: 123456"));
  assert.ok(extraContent.includes("[DOI-Audit"));
  assert.ok(extraContent.includes("10.1057/fake.bad -> 10.1057/real.good"));
  assert.ok(tags.includes("_doi_repaired"));
});

test("verifyDOI correctly identifies 404 non-existent DOI", async () => {
  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        if (url.includes("doiRA")) {
          return {
            status: 200,
            response: [{ status: "DOI does not exist" }],
          };
        }
        return { status: 404 };
      },
    },
  };
  const mod = loadModule(
    `${root}/src/modules/DOICompleter.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
    },
    { Zotero: customZotero },
  );

  const res = await mod.verifyDOI(
    "10.1057/s41289-022-00192-5",
    "Street network or functional attractors?",
  );
  assert.equal(res.status, "not_found");
  assert.ok(res.message.includes("404"));
});

test("verifyDOI flags mismatched DOI (hallucinated real DOI belonging to other paper)", async () => {
  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        if (url.includes("doiRA")) {
          return {
            status: 200,
            response: [{ RA: "Crossref" }],
          };
        }
        if (url.includes("api.crossref.org/works/10.1016")) {
          return {
            status: 200,
            response: {
              message: {
                title: ["Analyzing pedestrian individual and interaction collision avoidance dynamics"],
                issued: { "date-parts": [[2021]] },
                author: [{ family: "Qu" }, { family: "Wu" }],
              },
            },
          };
        }
        return { status: 404 };
      },
    },
  };
  const mod = loadModule(
    `${root}/src/modules/DOICompleter.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
    },
    { Zotero: customZotero },
  );

  const res = await mod.verifyDOI(
    "10.1016/j.trc.2021.103445",
    "Street network or functional attractors? Space syntax MCDA",
    2022,
    "Yang",
  );
  assert.equal(res.status, "mismatched");
  assert.ok(res.registeredTitle.includes("collision avoidance"));
});

test("verifyDOI flags valid DOI when metadata matches title and author", async () => {
  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        if (url.includes("doiRA")) {
          return {
            status: 200,
            response: [{ RA: "Crossref" }],
          };
        }
        if (url.includes("api.crossref.org/works/10.1002")) {
          return {
            status: 200,
            response: {
              message: {
                title: ["Microscopic decision model for pedestrian route choice at signalized crosswalks"],
                issued: { "date-parts": [[2016]] },
                author: [{ family: "Xie" }, { family: "Wong" }],
              },
            },
          };
        }
        return { status: 404 };
      },
    },
  };
  const mod = loadModule(
    `${root}/src/modules/DOICompleter.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
    },
    { Zotero: customZotero },
  );

  const res = await mod.verifyDOI(
    "10.1002/atr.1396",
    "Microscopic decision model for pedestrian route choice at signalized crosswalks",
    2016,
    "Xie",
  );
  assert.equal(res.status, "valid");
  assert.equal(res.doi, "10.1002/atr.1396");
});

test("verifyAndRepairItemDOI corrects a mismatched DOI using OpenAlex and Crossref search", async () => {
  const fields = {
    title: "Street network or functional attractors? Space syntax MCDA",
    DOI: "10.1016/j.trc.2021.103445",
    date: "2022",
    extra: "",
  };
  const tags = [];
  const fakeItem = {
    isRegularItem: () => true,
    getDisplayTitle: () => fields.title,
    getField: (f) => fields[f] || "",
    setField: (f, v) => {
      fields[f] = v;
    },
    getCreators: () => [{ lastName: "Yang" }],
    getBestAttachments: async () => [],
    addTag: (t) => tags.push(t),
    removeTag: (t) => {
      const idx = tags.indexOf(t);
      if (idx !== -1) tags.splice(idx, 1);
    },
    saveTx: async () => {},
  };

  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        // 1. doiRA check for current DOI (exists)
        if (url.includes("doiRA/10.1016")) {
          return { status: 200, response: [{ RA: "Crossref" }] };
        }
        // 2. Metadata for current DOI (mismatched)
        if (url.includes("api.crossref.org/works/10.1016")) {
          return {
            status: 200,
            response: {
              message: {
                title: ["Completely unrelated collision avoidance paper"],
                author: [{ family: "Qu" }],
                issued: { "date-parts": [[2021]] },
              },
            },
          };
        }
        // 3. OpenAlex search for real paper
        if (url.includes("api.openalex.org/works?search=")) {
          return {
            status: 200,
            response: {
              results: [
                {
                  doi: "https://doi.org/10.1057/s41289-022-00178-w",
                  title: "Street network or functional attractors? Space syntax MCDA",
                  publication_year: 2022,
                  authorships: [{ author: { display_name: "S. Yang" } }],
                },
              ],
            },
          };
        }
        // 4. Crossref search fallback
        if (url.includes("api.crossref.org/works?query.bibliographic=")) {
          return {
            status: 200,
            response: { message: { items: [] } },
          };
        }
        return { status: 404 };
      },
    },
  };

  const mod = loadModule(
    `${root}/src/modules/DOICompleter.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
    },
    { Zotero: customZotero },
  );

  const report = await mod.verifyAndRepairItemDOI(fakeItem, "sanfy007@gmail.com");
  assert.equal(report.outcome, "repaired");
  assert.equal(report.oldDOI, "10.1016/j.trc.2021.103445");
  assert.equal(report.newDOI, "10.1057/s41289-022-00178-w");
  assert.equal(fields.DOI, "10.1057/s41289-022-00178-w");
  assert.ok(fields.extra.includes("[DOI-Audit"));
  assert.ok(fields.extra.includes("10.1016/j.trc.2021.103445 -> 10.1057/s41289-022-00178-w"));
  assert.ok(tags.includes("_doi_repaired"));
});
