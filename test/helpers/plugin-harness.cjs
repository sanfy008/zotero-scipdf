const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

const root = path.dirname(require.resolve("../../package.json"));
const TITLE = "Pedestrian movement in urban networks";
const BAD_DOI = "10.1000/wrong-paper";
const GOOD_DOI = "10.1000/correct-paper";
const RESOLVERS_PREF = "extensions.zotero.findPDFs.resolvers";
let nextID = 1;

function makeItem(fields = {}, surname = "Wang") {
  const values = {
    title: TITLE,
    DOI: "",
    date: "2024",
    extra: "",
    url: "",
    ...fields,
  };
  const tags = new Set();
  const item = {
    id: nextID++,
    libraryID: 1,
    itemTypeID: 1,
    deleted: false,
    fields: values,
    attachmentIDs: [],
    saved: 0,
    isRegularItem: () => true,
    getField: (field) => values[field] || "",
    setField: (field, value) => {
      values[field] = value;
    },
    getDisplayTitle: () => values.title,
    getCreators: () => (surname ? [{ lastName: surname }] : []),
    getBestAttachment: async () => null,
    getBestAttachments: async () => [],
    getAttachments: () => item.attachmentIDs,
    isFieldPermitted: () => true,
    getTags: () => Array.from(tags, (tag) => ({ tag })),
    hasTag: (tag) => tags.has(tag),
    addTag: (tag) => tags.add(tag),
    removeTag: (tag) => tags.delete(tag),
    saveTx: async () => {
      item.saved++;
    },
  };
  return item;
}

function makePDF(parent) {
  const attachment = {
    id: nextID++,
    deleted: false,
    isPDFAttachment: () => true,
    getFilePath: () => `C:/library/${parent.id}.pdf`,
  };
  parent.attachmentIDs.push(attachment.id);
  return attachment;
}

function harness({
  preferences = {},
  request,
  items = [],
  pdfs = [],
  realResolvers = false,
  configuredResolvers = [
    { name: "Sci-Hub", url: "https://mirror.invalid/{doi}" },
  ],
  installedResolvers = [],
  systemPreferences = {},
} = {}) {
  const calls = [],
    imports = [],
    links = [],
    windows = [];
  const prefs = {
    email: "test@example.invalid",
    completeDOI: true,
    reuseLocalPDF: false,
    autoEnrichMetadata: false,
    openAlex: true,
    unpaywall: false,
    semanticScholar: false,
    arxiv: false,
    scihubEnabled: true,
    ...preferences,
  };
  const systemPrefs = new Map(Object.entries(systemPreferences));
  systemPrefs.set(RESOLVERS_PREF, JSON.stringify(installedResolvers));
  const largePrefs = new Map([["resolvers", configuredResolvers]]);
  const registry = new Map(pdfs.map((pdf) => [pdf.id, pdf]));
  const addon = { data: { initialized: false, registeredMenuIDs: [] } };
  const Zotero = {
    debug() {},
    Prefs: {
      get(key) {
        const prefix = "extensions.zotero.scipdf.";
        if (key.startsWith(prefix)) return prefs[key.slice(prefix.length)];
        if (key === "extensions.sci-pdf.email") return prefs.email;
        return systemPrefs.get(key);
      },
      set(key, value) {
        systemPrefs.set(key, value);
      },
    },
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    getMainWindows: () => [],
    Items: { getAll: async () => items, get: (id) => registry.get(id) },
    HTTP: {
      request: async (method, url, options) => {
        calls.push(url);
        return request ? request(method, url, options) : { status: 404 };
      },
    },
    Attachments: {
      importFromURL: async (options) => {
        imports.push(options.url);
        return { id: nextID++ };
      },
      linkFromFile: async (options) => {
        links.push(options.file);
        return { id: nextID++ };
      },
    },
  };
  class ProgressWindow {
    constructor(title) {
      this.title = title;
      this.win = { close() {} };
      windows.push(this);
    }
    createLine() {
      return this;
    }
    show() {}
    addDescription() {}
    changeLine() {}
  }
  class LargePrefHelper {
    getValue(key) {
      return largePrefs.get(key);
    }
    setValue(key, value) {
      largePrefs.set(key, value);
    }
  }

  // All real modules share host objects and a module cache. Stub only the UI,
  // storage adapter, and network; unexpected dependencies still fail loudly.
  const cache = new Map();
  cache.set(path.join(root, "src/utils/prefs.ts"), {
    getPref: (key) => prefs[key],
    setPref: (key, value) => {
      prefs[key] = value;
    },
  });
  cache.set(path.join(root, "src/utils/locale.ts"), {
    getString: (key) => key,
    initLocale() {},
  });
  cache.set(path.join(root, "src/utils/ztoolkit.ts"), {
    createZToolkit: () => ({}),
  });
  cache.set(path.join(root, "src/modules/Common.ts"), {
    Common: { async registerPrefs() {}, registerRightClickMenuItem() {} },
  });
  if (!realResolvers) {
    cache.set(path.join(root, "src/modules/CustomResolverManager.ts"), {
      CustomResolverManager: {
        shared: { customResolvers: configuredResolvers },
      },
    });
  }

  function load(file) {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename);
    if (filename.endsWith(".json")) {
      const value = JSON.parse(readFileSync(filename, "utf8"));
      cache.set(filename, value);
      return value;
    }
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const run = runInNewContext(
      `(function (exports, require, module) {\n${outputText}\n})`,
      {
        Zotero,
        addon,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        ztoolkit: { ProgressWindow, log() {} },
      },
      { filename },
    );
    run(
      module.exports,
      (id) => {
        if (id === "zotero-plugin-toolkit") return { LargePrefHelper };
        assert.ok(id.startsWith("."), `Unexpected external import: ${id}`);
        const target = path.resolve(path.dirname(filename), id);
        return load(path.extname(target) ? target : `${target}.ts`);
      },
      module,
    );
    return module.exports;
  }
  return {
    load,
    calls,
    imports,
    links,
    windows,
    prefs,
    addon,
    Zotero,
    installedResolvers: () =>
      JSON.parse(systemPrefs.get(RESOLVERS_PREF) || "[]"),
  };
}

function openAlexWork({
  doi = GOOD_DOI,
  year = 2024,
  author = "Jane Wang",
} = {}) {
  return {
    doi: doi ? `https://doi.org/${doi}` : null,
    title: TITLE,
    publication_year: year,
    publication_date: `${year}-01-01`,
    authorships: [{ author: { display_name: author } }],
    abstract_inverted_index: { Correct: [0], abstract: [1] },
    primary_location: { source: { display_name: "Correct Journal" } },
  };
}

function wrongDOIResponse(_method, url) {
  if (url.includes("doiRA/"))
    return { status: 200, response: [{ RA: "Crossref" }] };
  if (url.startsWith("https://api.crossref.org/works/")) {
    return {
      status: 200,
      response: {
        message: {
          title: ["An unrelated study of tropical forests"],
          issued: { "date-parts": [[2010]] },
          author: [{ family: "Smith" }],
        },
      },
    };
  }
  if (url.includes("api.crossref.org/works?"))
    return { status: 200, response: { message: { items: [] } } };
  if (url.includes("api.openalex.org/works?"))
    return { status: 200, response: { results: [] } };
  if (url.includes("api.openalex.org/works/doi:")) {
    return {
      status: 200,
      response: {
        locations: [{ pdf_url: "https://papers.invalid/wrong.pdf" }],
      },
    };
  }
  if (url.startsWith("https://mirror.invalid/")) {
    return {
      status: 200,
      responseXML: {
        documentElement: { innerHTML: "PDF" },
        querySelector: (selector) =>
          selector === "#pdf"
            ? { getAttribute: () => "https://papers.invalid/wrong.pdf" }
            : null,
      },
    };
  }
  return { status: 404 };
}

module.exports = {
  harness,
  makeItem,
  makePDF,
  openAlexWork,
  wrongDOIResponse,
  TITLE,
  BAD_DOI,
  GOOD_DOI,
};
