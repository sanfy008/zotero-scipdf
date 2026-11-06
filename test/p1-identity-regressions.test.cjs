const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  harness,
  makeItem,
  makePDF,
  openAlexWork,
  wrongDOIResponse,
  TITLE,
  BAD_DOI,
  GOOD_DOI,
} = require("./helpers/plugin-harness.cjs");

const rejectedReport = (detail = "mismatched") => ({
  outcome: "unresolved",
  oldDOI: BAD_DOI,
  detail,
});

test("only explicit unresolved negative DOI checks block lookup", () => {
  const h = harness();
  const { isDOIRejected } = h.load("src/modules/DOICompleter.ts");
  assert.equal(isDOIRejected(), false);
  assert.equal(isDOIRejected({ outcome: "valid", newDOI: GOOD_DOI }), false);
  assert.equal(
    isDOIRejected({
      outcome: "repaired",
      newDOI: GOOD_DOI,
      detail: "mismatched",
    }),
    false,
  );
  assert.equal(
    isDOIRejected({ outcome: "unresolved", detail: "missing" }),
    false,
  );
  assert.equal(
    isDOIRejected({ outcome: "unresolved", message: "Network inconclusive" }),
    false,
  );
  assert.equal(isDOIRejected(rejectedReport("mismatched")), true);
  assert.equal(isDOIRejected(rejectedReport("not_found")), true);
});

test("high title similarity cannot override author or year contradictions", async (t) => {
  for (const [name, year, author] of [
    ["year", 2010, "Wang"],
    ["author", 2024, "Smith"],
    ["year and author", 2010, "Smith"],
  ]) {
    await t.test(name, async () => {
      const h = harness({
        request: async (_method, url) =>
          url.includes("doiRA/")
            ? { status: 200, response: [{ RA: "Crossref" }] }
            : {
                status: 200,
                response: {
                  message: {
                    title: [TITLE],
                    issued: { "date-parts": [[year]] },
                    author: [{ family: author }],
                  },
                },
              },
      });
      const { verifyDOI } = h.load("src/modules/DOICompleter.ts");
      const report = await verifyDOI(BAD_DOI, TITLE, 2024, "Wang");
      assert.equal(report.status, "mismatched");
    });
  }
});

test("fetch never uses a rejected DOI for local, OA, or Sci-Hub PDFs", async (t) => {
  for (const mode of ["local", "oa", "scihub"]) {
    await t.test(mode, async () => {
      const owner = makeItem({ DOI: BAD_DOI });
      const pdf = makePDF(owner);
      const target = makeItem({ DOI: BAD_DOI });
      const h = harness({
        preferences: {
          reuseLocalPDF: mode === "local",
          openAlex: mode !== "scihub",
        },
        items: [owner, target],
        pdfs: [pdf],
        request: wrongDOIResponse,
      });
      const { SciHubFetcher } = h.load("src/modules/SciHubFetcher.ts");
      await SciHubFetcher.updateItems([target], false);
      assert.deepEqual(h.imports, []);
      assert.deepEqual(h.links, []);
      assert.ok(!h.calls.some((url) => url.includes("/works/doi:")));
      assert.ok(
        !h.calls.some((url) => url.startsWith("https://mirror.invalid/")),
      );
      assert.equal(
        target.fields.DOI,
        BAD_DOI,
        "preserve unresolved original value",
      );
    });
  }
});

test("enrichment never queries a DOI explicitly rejected by verification", async (t) => {
  for (const detail of ["mismatched", "not_found"]) {
    await t.test(detail, async () => {
      const target = makeItem({ DOI: BAD_DOI });
      const h = harness({
        request: async (_method, url) =>
          url.includes("/works?")
            ? { status: 200, response: { results: [] } }
            : { status: 200, response: openAlexWork({ doi: BAD_DOI }) },
      });
      const { enrichSingleItem } = h.load("src/modules/MetadataEnricher.ts");
      const report = await enrichSingleItem(target, "", rejectedReport(detail));
      assert.equal(report.outcome, "not_found");
      assert.ok(h.calls.every((url) => url.includes("/works?")));
      assert.equal(target.getField("abstractNote"), "");
      assert.equal(target.saved, 0);
    });
  }
});

test("metadata title lookup rejects conflicting author or year", async (t) => {
  for (const [name, year, author] of [
    ["year", 2010, "Jane Wang"],
    ["author", 2024, "Jane Smith"],
    ["year and author", 2010, "Jane Smith"],
  ]) {
    await t.test(name, async () => {
      const target = makeItem();
      const h = harness({
        request: async () => ({
          status: 200,
          response: { results: [openAlexWork({ year, author })] },
        }),
      });
      const { enrichSingleItem } = h.load("src/modules/MetadataEnricher.ts");
      const report = await enrichSingleItem(target, "", {
        outcome: "unresolved",
        detail: "missing",
      });
      assert.equal(report.outcome, "not_found");
      assert.equal(target.fields.DOI, "");
      assert.equal(target.getField("abstractNote"), "");
      assert.equal(target.saved, 0);
    });
  }
});

test("metadata title lookup accepts a corroborated candidate after rejecting a conflict", async () => {
  const target = makeItem();
  const h = harness({
    request: async () => ({
      status: 200,
      response: {
        results: [
          openAlexWork({ doi: BAD_DOI, year: 2010, author: "Jane Smith" }),
          openAlexWork(),
        ],
      },
    }),
  });
  const { enrichSingleItem } = h.load("src/modules/MetadataEnricher.ts");
  const report = await enrichSingleItem(target, "", {
    outcome: "unresolved",
    detail: "missing",
  });
  assert.equal(report.outcome, "enriched");
  assert.equal(report.doi, GOOD_DOI, "report the match without writing it");
  assert.equal(target.fields.DOI, "");
  assert.equal(target.getField("abstractNote"), "Correct abstract");
});

test("title fallback cannot re-admit a rejected DOI and never writes it back", async () => {
  const target = makeItem({ DOI: BAD_DOI });
  target.addTag("_doi_invalid");
  const h = harness({
    request: async () => ({
      status: 200,
      response: { results: [openAlexWork({ doi: BAD_DOI }), openAlexWork()] },
    }),
  });
  const { enrichSingleItem } = h.load("src/modules/MetadataEnricher.ts");
  const report = await enrichSingleItem(target, "", rejectedReport());
  assert.equal(report.outcome, "enriched");
  assert.ok(h.calls.every((url) => url.includes("/works?")));
  assert.equal(
    target.fields.DOI,
    BAD_DOI,
    "leave DOI repair to the audit action",
  );
  assert.ok(!target.fields.extra.includes("[DOI-Audit"));
  assert.equal(target.hasTag("_doi_invalid"), true);
});

test("a corroborated work without a DOI can still supply metadata", async () => {
  const target = makeItem();
  const h = harness({
    request: async () => ({
      status: 200,
      response: { results: [openAlexWork({ doi: null })] },
    }),
  });
  const { enrichSingleItem } = h.load("src/modules/MetadataEnricher.ts");
  const report = await enrichSingleItem(target, "", {
    outcome: "unresolved",
    detail: "missing",
  });
  assert.equal(report.outcome, "enriched");
  assert.equal(target.fields.DOI, "");
  assert.equal(target.getField("abstractNote"), "Correct abstract");
});

test("local title fallback refuses an explicit DOI conflict", async () => {
  const owner = makeItem({ DOI: BAD_DOI });
  const pdf = makePDF(owner);
  const target = makeItem({ DOI: GOOD_DOI });
  const h = harness({ items: [owner], pdfs: [pdf] });
  const { LocalPDFIndex } = h.load("src/modules/LocalPDFIndex.ts");
  const index = await LocalPDFIndex.build(1);
  assert.equal(index.find(target), null);
});

test("local title fallback still accepts a corroborated owner without a DOI", async () => {
  const owner = makeItem();
  const pdf = makePDF(owner);
  const target = makeItem({ DOI: GOOD_DOI });
  const h = harness({ items: [owner], pdfs: [pdf] });
  const { LocalPDFIndex } = h.load("src/modules/LocalPDFIndex.ts");
  const index = await LocalPDFIndex.build(1);
  const match = index.find(target);
  assert.ok(match);
  assert.equal(match.evidence, "title");
});

test("older verification tags cannot bypass current author/year checks", async () => {
  const target = makeItem({ DOI: BAD_DOI });
  target.addTag(`_doi_verified:${BAD_DOI}`);
  const h = harness({
    request: async (method, url) => {
      if (url.startsWith("https://api.crossref.org/works/")) {
        return {
          status: 200,
          response: {
            message: {
              title: [TITLE],
              issued: { "date-parts": [[2010]] },
              author: [{ family: "Smith" }],
            },
          },
        };
      }
      return wrongDOIResponse(method, url);
    },
  });
  const { verifyAndRepairItemDOI } = h.load("src/modules/DOICompleter.ts");
  const report = await verifyAndRepairItemDOI(target);
  assert.equal(report.outcome, "unresolved");
  assert.equal(report.detail, "mismatched");
  assert.ok(h.calls.some((url) => url.includes("doiRA/")));
});

test("changed item evidence is rechecked using cached registry metadata", async () => {
  const target = makeItem({ DOI: GOOD_DOI });
  const h = harness({
    request: async (method, url) => {
      if (url.startsWith("https://api.crossref.org/works/")) {
        return {
          status: 200,
          response: {
            message: {
              title: [TITLE],
              issued: { "date-parts": [[2024]] },
              author: [{ family: "Wang" }],
            },
          },
        };
      }
      return wrongDOIResponse(method, url);
    },
  });
  const { verifyAndRepairItemDOI } = h.load("src/modules/DOICompleter.ts");
  assert.equal((await verifyAndRepairItemDOI(target)).outcome, "valid");
  assert.ok(target.hasTag(`_doi_verified:${GOOD_DOI}`));
  target.fields.date = "2010";
  const report = await verifyAndRepairItemDOI(target);
  assert.equal(report.outcome, "unresolved");
  assert.equal(report.detail, "mismatched");
  assert.equal(h.calls.filter((url) => url.includes("doiRA/")).length, 1);
  assert.equal(
    h.calls.filter((url) => url.startsWith("https://api.crossref.org/works/"))
      .length,
    1,
  );
});
