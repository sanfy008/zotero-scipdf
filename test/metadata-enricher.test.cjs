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
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id.endsWith("/constants")) return { API_USER_AGENT: "zotero-scipdf" };
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
  Prefs: {
    get: () => "",
    set: () => {},
  },
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

// MetadataEnricher delegates hard-timeout HTTP to DOICompleter's helper. Each
// loadModule() call gets its own VM, so the shared helper must be rebound to
// this test's custom Zotero for the request to land in the right stub.
function completerWith(zotero) {
  return {
    ...completerModule,
    requestWithHardTimeout: (method, url, options = {}, timeoutMs = 10000) =>
      zotero.HTTP.request(method, url, { ...options, timeout: timeoutMs }),
  };
}

const enricherModule = loadModule(
  `${root}/src/modules/MetadataEnricher.ts`,
  {
    "../utils/identifierPatterns": identifiers,
    "../utils/utils": { Utils },
    "./DOICompleter": completerModule,
  },
  { Zotero: fakeZotero },
);

const {
  reconstructOpenAlexAbstract,
  cleanCrossrefAbstract,
  cleanDataCiteAbstract,
  enrichItemWithMetadata,
} = enricherModule;

const { cleanDOI } = identifiers;

test("cleanDOI sanitizes URL-encoded slashes, query parameters, hash fragments, and trailing punctuation", () => {
  assert.equal(
    cleanDOI("https://doi.org/10.1016%2Fj.future.2020.10.001?fr=alldoi#sec1/"),
    "10.1016/j.future.2020.10.001",
  );
  assert.equal(
    cleanDOI("doi: 10.1109/TITS.2021.3065000."),
    "10.1109/TITS.2021.3065000",
  );
  assert.equal(
    cleanDOI("10.1038/s41586-020-2649-2;"),
    "10.1038/s41586-020-2649-2",
  );
});

test("reconstructOpenAlexAbstract accurately reconstructs continuous text from inverted index", () => {
  const inverted = {
    Deep: [0],
    learning: [1],
    has: [2],
    revolutionized: [3],
    transportation: [4],
    "networks.": [5],
  };
  const result = reconstructOpenAlexAbstract(inverted);
  assert.equal(
    result,
    "Deep learning has revolutionized transportation networks.",
  );
});

test("reconstructOpenAlexAbstract handles repeated words and out-of-order indices", () => {
  const inverted = {
    be: [1, 3],
    To: [0],
    or: [2],
    not: [4],
    to: [5],
    "be.": [6],
  };
  const result = reconstructOpenAlexAbstract(inverted);
  assert.equal(result, "To be or be not to be.");
});

test("reconstructOpenAlexAbstract returns null for invalid or empty inputs", () => {
  assert.equal(reconstructOpenAlexAbstract(null), null);
  assert.equal(reconstructOpenAlexAbstract(undefined), null);
  assert.equal(reconstructOpenAlexAbstract({}), null);
  assert.equal(reconstructOpenAlexAbstract({ invalid: [] }), null);
});

test("cleanCrossrefAbstract strips JATS XML tags, decodes entities and trims whitespace", () => {
  const rawJats = `
    <jats:title>Abstract</jats:title>
    <jats:p>Recent advances in &lt;AI&gt; &amp; machine learning have accelerated autonomous driving.</jats:p>
    <jats:sec><jats:p>Results show a 95&percnt; &quot;accuracy&quot; improvement.</jats:p></jats:sec>
  `;
  const result = cleanCrossrefAbstract(rawJats);
  assert.ok(!result.includes("<jats:"));
  assert.ok(result.includes("<AI> & machine learning"));
  assert.ok(result.includes('"accuracy"'));
  assert.ok(!result.startsWith("Abstract"));
});

test("cleanCrossrefAbstract returns null for empty or non-string inputs", () => {
  assert.equal(cleanCrossrefAbstract(null), null);
  assert.equal(cleanCrossrefAbstract(""), null);
  assert.equal(cleanCrossrefAbstract("   <jats:p></jats:p>   "), null);
});

test("cleanDataCiteAbstract extracts abstract and strips markup", () => {
  const descriptions = [
    { description: "Dataset overview", descriptionType: "SeriesInformation" },
    {
      description:
        "<p>This preprint presents a new benchmark dataset for multimodal traffic prediction.</p>",
      descriptionType: "Abstract",
    },
  ];
  const result = cleanDataCiteAbstract(descriptions);
  assert.equal(
    result,
    "This preprint presents a new benchmark dataset for multimodal traffic prediction.",
  );
});

test("enrichItemWithMetadata enriches only empty fields and records audit note", async () => {
  const fields = {
    title: "Graph Neural Networks for Traffic Forecasting",
    date: "2021",
    abstractNote: "",
    publicationTitle: "",
    volume: "",
    issue: "",
    pages: "",
    extra: "Citation Key: smith2021",
  };
  const tags = [];
  let saved = false;

  const fakeItem = {
    getField: (name) => fields[name] || "",
    setField: (name, val) => {
      fields[name] = val;
    },
    isFieldPermitted: () => true,
    addTag: (t) => tags.push(t),
    saveTx: async () => {
      saved = true;
    },
  };

  const metadata = {
    abstract: "We propose a novel spatial-temporal graph neural network...",
    publicationTitle: "IEEE Transactions on Intelligent Transportation Systems",
    volume: "22",
    issue: "4",
    pages: "2100-2112",
    date: "2021-04-12",
    year: 2021,
    source: "openalex",
  };

  const report = await enrichItemWithMetadata(fakeItem, metadata);

  assert.equal(report.hasAbstract, true);
  assert.ok(report.updatedFields.includes("abstractNote"));
  assert.ok(report.updatedFields.includes("publicationTitle"));
  assert.ok(report.updatedFields.includes("volume"));
  assert.ok(report.updatedFields.includes("issue"));
  assert.ok(report.updatedFields.includes("pages"));
  // Existing date "2021" must NOT be overwritten!
  assert.equal(fields.date, "2021");
  assert.equal(
    fields.abstractNote,
    "We propose a novel spatial-temporal graph neural network...",
  );
  assert.equal(
    fields.publicationTitle,
    "IEEE Transactions on Intelligent Transportation Systems",
  );
  assert.equal(fields.volume, "22");
  assert.equal(fields.issue, "4");
  assert.equal(fields.pages, "2100-2112");

  // Extra field should contain audit trail and preserve existing key
  assert.ok(fields.extra.includes("Citation Key: smith2021"));
  assert.ok(fields.extra.includes("[Metadata-Enriched"));
  assert.ok(fields.extra.includes("abstractNote, publicationTitle"));
  assert.ok(tags.includes("_metadata_enriched"));
  assert.equal(saved, true);
});

test("enrichItemWithMetadata does not modify items when all fields are populated", async () => {
  const fields = {
    abstractNote: "Existing abstract.",
    publicationTitle: "Existing Journal",
    date: "2023",
    volume: "10",
    issue: "2",
    pages: "100-110",
    extra: "Existing extra",
  };
  let saved = false;

  const fakeItem = {
    getField: (name) => fields[name] || "",
    setField: (name, val) => {
      fields[name] = val;
    },
    isFieldPermitted: () => true,
    addTag: () => {},
    saveTx: async () => {
      saved = true;
    },
  };

  const metadata = {
    abstract: "New remote abstract",
    publicationTitle: "New Journal",
    volume: "11",
    issue: "3",
    pages: "120-130",
    source: "crossref",
  };

  const report = await enrichItemWithMetadata(fakeItem, metadata);
  assert.equal(report.updatedFields.length, 0);
  assert.equal(saved, false);
  assert.equal(fields.abstractNote, "Existing abstract.");
});

test("MetadataManager executes batch enrichment, updates items, and produces summary", async () => {
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
        return `Enrichment: ${options.args.total} total, ${options.args.enriched} enriched, ${options.args.abstracts} abstracts, ${options.args.complete} complete, ${options.args.failed} failed`;
      }
      return key;
    },
  };

  const fakeEnricher = {
    enrichSingleItem: async (item) => {
      if (item.id === 1) {
        return {
          outcome: "enriched",
          itemTitle: item.title,
          updatedFields: ["abstractNote", "publicationTitle"],
          hasAbstract: true,
        };
      }
      if (item.id === 2) {
        return {
          outcome: "already_complete",
          itemTitle: item.title,
          updatedFields: [],
          hasAbstract: true,
        };
      }
      return {
        outcome: "not_found",
        itemTitle: item.title,
        updatedFields: [],
        hasAbstract: false,
      };
    },
  };

  const managerModule = loadModule(
    `${root}/src/modules/MetadataManager.ts`,
    {
      "../utils/locale": fakeLocale,
      "../utils/utils": { Utils: fakeUtils },
      "./MetadataEnricher": fakeEnricher,
      "./OperationGate": {
        runExclusive: async (task) => {
          await task();
          return true;
        },
      },
    },
    { Zotero: fakeZotero },
  );

  const items = [
    {
      id: 1,
      title: "Paper 1",
      isRegularItem: () => true,
      getDisplayTitle: () => "Paper 1",
    },
    {
      id: 2,
      title: "Paper 2",
      isRegularItem: () => true,
      getDisplayTitle: () => "Paper 2",
    },
    {
      id: 3,
      title: "Paper 3",
      isRegularItem: () => true,
      getDisplayTitle: () => "Paper 3",
    },
  ];

  await managerModule.MetadataManager.enrichItems(items);

  const lastLine = winLines[winLines.length - 1];
  assert.equal(
    lastLine.text,
    "Enrichment: 3 total, 1 enriched, 1 abstracts, 1 complete, 1 failed",
  );
  assert.equal(lastLine.type, "success");
  assert.equal(lastLine.progress, 100);
});

test("fetchUnifiedMetadata cascades and short-circuits when OpenAlex metadata is complete", async () => {
  const requestedUrls = [];
  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        requestedUrls.push(url);
        if (url.includes("api.openalex.org")) {
          return {
            status: 200,
            response: {
              doi: "https://doi.org/10.1000/182",
              title: "Complete OpenAlex Paper",
              publication_year: 2023,
              publication_date: "2023-05-01",
              abstract_inverted_index: { Full: [0], abstract: [1], text: [2] },
              primary_location: {
                source: { display_name: "Nature Machine Intelligence" },
              },
              biblio: {
                volume: "5",
                issue: "5",
                first_page: "100",
                last_page: "110",
              },
              authorships: [{ author: { display_name: "Jane Doe" } }],
            },
          };
        }
        if (url.includes("api.crossref.org")) {
          return {
            status: 200,
            response: { message: { title: ["Crossref Title"] } },
          };
        }
        return { status: 404 };
      },
    },
  };

  const module = loadModule(
    `${root}/src/modules/MetadataEnricher.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
      "./DOICompleter": completerWith(customZotero),
    },
    { Zotero: customZotero },
  );

  module.clearMetadataEnricherCache();

  // First call: should query OpenAlex and short-circuit without querying Crossref
  const meta = await module.fetchUnifiedMetadata("10.1000/182");
  assert.ok(meta);
  assert.equal(meta.title, "Complete OpenAlex Paper");
  assert.equal(meta.publicationTitle, "Nature Machine Intelligence");
  assert.equal(meta.abstract, "Full abstract text");
  assert.equal(requestedUrls.length, 1);
  assert.ok(requestedUrls[0].includes("api.openalex.org"));

  // Second call: should hit unifiedMetadataCache without making ANY network calls
  const cachedMeta = await module.fetchUnifiedMetadata("10.1000/182");
  assert.equal(cachedMeta.title, "Complete OpenAlex Paper");
  assert.equal(requestedUrls.length, 1); // no extra requests!
});

test("fetchUnifiedMetadata falls back to Crossref when OpenAlex is incomplete", async () => {
  const requestedUrls = [];
  const customZotero = {
    debug: () => {},
    HTTP: {
      request: async (method, url) => {
        requestedUrls.push(url);
        if (url.includes("api.openalex.org")) {
          // OpenAlex has title and year, but missing abstract and publicationTitle
          return {
            status: 200,
            response: {
              doi: "https://doi.org/10.1000/partial",
              title: "Partial OpenAlex Paper",
              publication_year: 2022,
              publication_date: "2022-01-01",
            },
          };
        }
        if (url.includes("api.crossref.org")) {
          return {
            status: 200,
            response: {
              message: {
                title: ["Crossref Complete Title"],
                "container-title": [
                  "IEEE Transactions on Intelligent Transportation Systems",
                ],
                abstract: "<jats:p>Crossref abstract text here.</jats:p>",
                volume: "23",
                issue: "4",
                page: "123-130",
              },
            },
          };
        }
        return { status: 404 };
      },
    },
  };

  const module = loadModule(
    `${root}/src/modules/MetadataEnricher.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
      "./DOICompleter": completerWith(customZotero),
    },
    { Zotero: customZotero },
  );

  module.clearMetadataEnricherCache();

  const meta = await module.fetchUnifiedMetadata("10.1000/partial");
  assert.ok(meta);
  // Merged: title from OpenAlex, abstract and journal from Crossref
  assert.equal(meta.title, "Partial OpenAlex Paper");
  assert.equal(
    meta.publicationTitle,
    "IEEE Transactions on Intelligent Transportation Systems",
  );
  assert.equal(meta.abstract, "Crossref abstract text here.");
  assert.equal(meta.volume, "23");
  assert.equal(requestedUrls.length, 2); // both were queried to fill gaps
});

test("enrichItemWithMetadata maps publicationTitle to proceedingsTitle for conference papers", async () => {
  const fields = {};
  const fakeItem = {
    isFieldPermitted: (f) => f === "proceedingsTitle" || f === "abstractNote",
    getField: (f) => fields[f] || "",
    setField: (f, v) => {
      fields[f] = v;
    },
    addTag: () => {},
    saveTx: async () => {},
  };

  const enrichRes = await enricherModule.enrichItemWithMetadata(fakeItem, {
    publicationTitle: "Proceedings of the 2026 IEEE ITSC",
    abstract: "Conference paper abstract",
  });

  assert.equal(fields.proceedingsTitle, "Proceedings of the 2026 IEEE ITSC");
  assert.equal(fields.publicationTitle, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(enrichRes.updatedFields)), [
    "abstractNote",
    "proceedingsTitle",
  ]);
});

test("a later enrichment is still audited in `extra`", async () => {
  // Regression: the guard used to test for the literal "[Metadata-Enriched",
  // which is present after the first run, so every subsequent enrichment
  // silently dropped its audit line.
  const today = new Date().toISOString().slice(0, 10);
  const fields = {
    title: "Some Paper",
    extra: `[Metadata-Enriched ${today}] Added: volume (source: crossref)`,
    abstractNote: "",
    publicationTitle: "Journal",
    date: "2020",
    volume: "1",
    issue: "2",
    pages: "3-4",
  };
  const item = {
    isRegularItem: () => true,
    getDisplayTitle: () => fields.title,
    getField: (f) => fields[f] || "",
    setField: (f, v) => {
      fields[f] = v;
    },
    addTag: () => {},
    saveTx: async () => {},
  };
  const mod = loadModule(
    `${root}/src/modules/MetadataEnricher.ts`,
    {
      "../utils/identifierPatterns": identifiers,
      "../utils/utils": { Utils },
      "./DOICompleter": completerModule,
    },
    { Zotero: fakeZotero },
  );

  await mod.enrichItemWithMetadata(item, {
    abstract: "A new abstract.",
    source: "openalex",
  });

  const lines = fields.extra.split("\n");
  assert.equal(lines.length, 2, "second audit line should be appended");
  assert.ok(lines[1].includes("abstractNote"));
  assert.ok(lines[1].includes("openalex"));
});
