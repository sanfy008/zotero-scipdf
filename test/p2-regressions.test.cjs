const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  harness,
  makeItem,
  openAlexWork,
  TITLE,
  BAD_DOI,
  GOOD_DOI,
} = require("./helpers/plugin-harness.cjs");

const ASCE_DOI = "10.1061/(ASCE)0733-9410(1993)119:1(119)";
const j = (value) => JSON.parse(JSON.stringify(value));

function metadataResponse(_method, url) {
  if (url.includes("doiRA/")) {
    return { status: 200, response: [{ status: "DOI does not exist" }] };
  }
  if (url.includes("api.crossref.org/works?")) {
    return { status: 200, response: { message: { items: [] } } };
  }
  if (url.includes("api.openalex.org/works?")) {
    return { status: 200, response: { results: [openAlexWork()] } };
  }
  if (url.includes("api.openalex.org/works/doi:")) {
    return { status: 200, response: openAlexWork() };
  }
  return { status: 404 };
}

function preferenceWindow() {
  const fields = new Map();
  const suffixes = [
    "autoDownload",
    "openAlex",
    "unpaywall",
    "semanticScholar",
    "arxiv",
    "completeDOI",
    "autoEnrichMetadata",
    "scihubEnabled",
    "reuseLocalPDF",
    "email",
    "scihubUrl",
  ];
  for (const suffix of suffixes) {
    const listeners = new Map();
    fields.set(suffix, {
      checked: false,
      value: "",
      addEventListener: (type, listener) => listeners.set(type, listener),
      dispatch: (type = "command") => listeners.get(type)?.(),
    });
  }
  return {
    document: {
      querySelector: (selector) =>
        fields.get(selector.replace("#zotero-prefpane-scipdf-", "")),
    },
    fields,
  };
}

function resolverFixtures(h) {
  const { sciHubCustomResolver, openAlexCustomResolver } = h.load(
    "src/modules/CustomResolver.ts",
  );
  return {
    oa: openAlexCustomResolver("", true),
    sci: sciHubCustomResolver("https://mirror.invalid", true),
    independent: {
      name: "Independent",
      method: "GET",
      mode: "html",
      selector: "#pdf",
      url: "https://independent.invalid/{doi}",
      automatic: false,
    },
  };
}

test("balanced DOI parentheses survive normalization and prose extraction", async (t) => {
  const h = harness();
  const { cleanDOI, matchDOIs } = h.load("src/utils/identifierPatterns.ts");
  for (const value of [
    ASCE_DOI,
    `https://doi.org/${ASCE_DOI}`,
    `doi: ${ASCE_DOI}`,
    ASCE_DOI.replace(/\(/g, "%28").replace(/\)/g, "%29"),
  ]) {
    await t.test(value, () => {
      assert.equal(cleanDOI(value), ASCE_DOI);
      assert.equal(cleanDOI(cleanDOI(value)), ASCE_DOI);
    });
  }
  for (const prose of [
    `(${ASCE_DOI}).`,
    `${ASCE_DOI}。`,
    `[${ASCE_DOI}]`,
    `${ASCE_DOI}); and more`,
  ]) {
    await t.test(prose, () =>
      assert.deepEqual(Array.from(matchDOIs(prose)), [ASCE_DOI]),
    );
  }
});

test("prose punctuation is still removed from non-parenthesized DOIs", () => {
  const { matchDOIs } = harness().load("src/utils/identifierPatterns.ts");
  for (const value of [
    "(10.1000/paper)",
    "10.1000/paper.",
    "[10.1000/paper]",
    "10.1000/paper; and more",
  ]) {
    assert.deepEqual(Array.from(matchDOIs(value)), ["10.1000/paper"]);
  }
});

test("automatic enrichment honors disabled DOI repair", async () => {
  const target = makeItem({ DOI: BAD_DOI });
  const h = harness({
    preferences: {
      completeDOI: false,
      autoEnrichMetadata: true,
      scihubEnabled: false,
    },
    request: metadataResponse,
  });
  await h
    .load("src/modules/SciHubFetcher.ts")
    .SciHubFetcher.updateItems([target], false);
  assert.equal(target.fields.DOI, BAD_DOI);
  assert.equal(target.getField("abstractNote"), "Correct abstract");
  assert.ok(!target.fields.extra.includes("[DOI-Audit"));
});

test("manual metadata enrichment also honors disabled DOI repair", async () => {
  const target = makeItem({ DOI: BAD_DOI });
  const h = harness({
    preferences: { completeDOI: false },
    request: metadataResponse,
  });
  await h
    .load("src/modules/MetadataManager.ts")
    .MetadataManager.enrichItems([target]);
  assert.equal(target.fields.DOI, BAD_DOI);
  assert.equal(target.getField("abstractNote"), "Correct abstract");
  assert.ok(!target.fields.extra.includes("[DOI-Audit"));
});

test("fresh installation keeps Sci-Hub out of built-in resolvers by default", async () => {
  const h = harness({
    realResolvers: true,
    configuredResolvers: [],
    preferences: { scihubEnabled: undefined },
  });
  await h.load("src/hooks.ts").default.onStartup();
  assert.ok(!h.installedResolvers().some((r) => r.name === "Sci-Hub"));
  const manager = h.load("src/modules/CustomResolverManager.ts")
    .CustomResolverManager.shared;
  assert.equal(
    manager.customResolvers.filter((r) => r.name === "Sci-Hub").length,
    3,
    "retain mirrors for later opt-in",
  );
  assert.ok(h.installedResolvers().some((r) => r.name === "OpenAlex"));
});

test("restart removes owned Sci-Hub resolvers when disabled without touching third parties", async () => {
  const fixtures = resolverFixtures(harness());
  const h = harness({
    realResolvers: true,
    preferences: { firstInstall: true, scihubEnabled: false },
    configuredResolvers: [fixtures.oa, fixtures.sci],
    installedResolvers: [fixtures.independent, fixtures.oa, fixtures.sci],
  });
  await h.load("src/hooks.ts").default.onStartup();
  assert.deepEqual(
    h.installedResolvers().map((r) => r.name),
    ["Independent", "OpenAlex"],
  );
  assert.ok(
    h
      .load("src/modules/CustomResolverManager.ts")
      .CustomResolverManager.shared.customResolvers.some(
        (r) => r.name === "Sci-Hub",
      ),
  );
});

test("the preferences Sci-Hub toggle immediately updates built-in resolvers", async () => {
  const h = harness({
    realResolvers: true,
    configuredResolvers: [],
    preferences: { scihubEnabled: true },
  });
  const { oa, sci, independent } = resolverFixtures(h);
  h.Zotero.Prefs.set(
    "extensions.zotero.findPDFs.resolvers",
    JSON.stringify([independent]),
  );
  const manager = h.load("src/modules/CustomResolverManager.ts")
    .CustomResolverManager.shared;
  manager.appendCustomResolversInZotero([oa, sci]);
  const win = preferenceWindow();
  await h.load("src/modules/preferenceScript.ts").registerPrefsScripts(win);
  const toggle = win.fields.get("scihubEnabled");
  toggle.checked = false;
  toggle.dispatch();
  assert.ok(!h.installedResolvers().some((r) => r.name === "Sci-Hub"));
  assert.ok(manager.customResolvers.some((r) => r.name === "Sci-Hub"));
  toggle.checked = true;
  toggle.dispatch();
  toggle.dispatch();
  assert.equal(
    h.installedResolvers().filter((r) => r.name === "Sci-Hub").length,
    1,
  );
  assert.deepEqual(
    h.installedResolvers().find((r) => r.name === "Independent"),
    j(independent),
  );
});

test("disabled mirrors remain configurable and can be re-enabled without duplicate resolvers", () => {
  const h = harness({
    realResolvers: true,
    configuredResolvers: [],
    preferences: { scihubEnabled: false },
  });
  const { oa, sci } = resolverFixtures(h);
  const manager = h.load("src/modules/CustomResolverManager.ts")
    .CustomResolverManager.shared;
  manager.appendCustomResolversInZotero([oa, sci]);
  assert.deepEqual(
    h.installedResolvers().map((r) => r.name),
    ["OpenAlex"],
  );
  h.prefs.scihubEnabled = true;
  manager.appendCustomResolversInZotero(manager.customResolvers);
  manager.appendCustomResolversInZotero(manager.customResolvers);
  assert.equal(
    h.installedResolvers().filter((r) => r.name === "Sci-Hub").length,
    1,
  );
});

test("an item without identifiers can fetch an arXiv PDF by title without writing a DOI", async () => {
  const target = makeItem();
  const h = harness({
    preferences: {
      completeDOI: false,
      arxiv: true,
      openAlex: false,
      scihubEnabled: false,
    },
    request: async (_method, url) => {
      assert.ok(url.startsWith("https://export.arxiv.org/api/query?"));
      return {
        status: 200,
        response: `<feed><entry><id>http://arxiv.org/abs/2401.12345</id><title>${TITLE}</title><link title="pdf" href="https://arxiv.org/pdf/2401.12345" /></entry></feed>`,
      };
    },
  });
  await h
    .load("src/modules/SciHubFetcher.ts")
    .SciHubFetcher.updateItems([target], false);
  assert.deepEqual(h.imports, ["https://arxiv.org/pdf/2401.12345.pdf"]);
  assert.equal(target.fields.DOI, "");
});

test("an item without identifiers can receive fallback metadata without writing a DOI", async () => {
  const target = makeItem();
  const h = harness({
    preferences: {
      completeDOI: false,
      autoEnrichMetadata: true,
      openAlex: false,
      scihubEnabled: false,
    },
    request: metadataResponse,
  });
  await h
    .load("src/modules/SciHubFetcher.ts")
    .SciHubFetcher.updateItems([target], false);
  assert.equal(target.getField("abstractNote"), "Correct abstract");
  assert.equal(target.fields.DOI, "");
  assert.ok(!h.windows.some((w) => w.title === "popwin-doimissing"));
});

test("PDF candidates dominate earlier landing candidates with the same URL", () => {
  const { orderCandidates } = harness().load("src/modules/OAResolver.ts");
  const out = orderCandidates([
    { url: "https://repo.invalid/a.pdf", kind: "landing", source: "Unpaywall" },
    { url: "https://repo.invalid/b.pdf", kind: "pdf", source: "Unpaywall" },
    {
      url: "https://repo.invalid/a.pdf",
      kind: "pdf",
      source: "Semantic Scholar",
    },
  ]);
  assert.deepEqual(j(out), [
    { url: "https://repo.invalid/b.pdf", kind: "pdf", source: "Unpaywall" },
    {
      url: "https://repo.invalid/a.pdf",
      kind: "pdf",
      source: "Semantic Scholar",
    },
  ]);
});

test("a PDF URL reported first as a landing page is still attached directly", async () => {
  const pdf = "https://repo.invalid/a.pdf";
  const target = makeItem({ DOI: GOOD_DOI });
  const h = harness({
    preferences: {
      completeDOI: false,
      unpaywall: true,
      semanticScholar: true,
      openAlex: false,
      scihubEnabled: false,
    },
    request: async (_method, url) => {
      if (url.includes("api.unpaywall.org"))
        return { status: 200, response: { best_oa_location: { url: pdf } } };
      if (url.includes("api.semanticscholar.org"))
        return { status: 200, response: { openAccessPdf: { url: pdf } } };
      return { status: 200, responseText: "%PDF-1.4" };
    },
  });
  await h
    .load("src/modules/SciHubFetcher.ts")
    .SciHubFetcher.updateItems([target], false);
  assert.deepEqual(h.imports, [pdf]);
  assert.ok(!h.calls.includes(pdf), "do not scrape the PDF as HTML");
});

test("URL deduplication normalizes host case but preserves case-sensitive paths", () => {
  const { orderCandidates } = harness().load("src/modules/OAResolver.ts");
  const out = orderCandidates([
    { url: "https://Repo.Invalid/A.pdf", kind: "pdf", source: "A" },
    { url: "https://repo.invalid/A.pdf", kind: "pdf", source: "B" },
    { url: "https://repo.invalid/a.pdf", kind: "pdf", source: "C" },
  ]);
  assert.equal(out.length, 2);
});
