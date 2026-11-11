import { assert } from "chai";
import { config } from "../package.json";
import { LocalPDFIndex } from "../src/modules/LocalPDFIndex";
import { Utils } from "../src/utils/utils";

describe("startup", function () {
  it("initializes and registers the item context menu", function () {
    const instance = Zotero[config.addonInstance];
    assert.isTrue(instance.data.initialized);
    if (Zotero.MenuManager && instance.data.registeredMenuIDs.length) {
      assert.lengthOf(instance.data.registeredMenuIDs, 1);
    } else {
      const doc = Zotero.getMainWindow().document;
      for (const id of ["scihub-fetch", "doi-verify", "enrich-metadata"]) {
        assert.isNotNull(doc.getElementById(`zotero-itemmenu-${id}`));
      }
    }
  });

  it("reuses an available main PDF rather than a supplement or a missing file", async function () {
    const doi = "10.1000/scipdf-host-fixture";
    const owner = new Zotero.Item("journalArticle");
    const target = new Zotero.Item("journalArticle");
    for (const item of [owner, target]) {
      item.setField("title", "SciPDF isolated host fixture");
      item.setField("DOI", doi);
      await item.saveTx();
    }
    const file = Zotero.getTempDirectory();
    file.append("scipdf-host-fixture.pdf");
    file.createUnique(0, 0o600);
    try {
      await Zotero.File.putContentsAsync(file, "%PDF-1.4\n%%EOF\n");
      const create = (title: string) =>
        Zotero.Attachments.linkFromFile({
          file: file.path,
          parentItemID: owner.id,
          title,
          contentType: "application/pdf",
        });
      const supplement = await create("Supplementary material");
      const missing = await create("Missing PDF");
      const main = await create("Full text PDF");
      missing.attachmentPath = `${file.path}.missing`;
      await missing.saveTx();
      const index = await LocalPDFIndex.build(owner.libraryID);
      assert.strictEqual(await missing.getFilePathAsync(), false);
      assert.notEqual(supplement.id, main.id);
      const match = await index.findAvailable(target);
      assert.equal(match?.attachment.id, main.id);
      assert.equal(match?.filePath, file.path);
    } finally {
      file.remove(false);
    }
  });

  it("imports only bytes that are actually a PDF", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "SciPDF verified download fixture");
    await item.saveTx();

    await Utils.attachRemotePDF(
      new URL(
        "https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/tracemonkey.pdf",
      ),
      item,
    );
    const [attachmentID] = item.getAttachments();
    const attachment = Zotero.Items.get(attachmentID);
    assert.equal(attachment.attachmentContentType, "application/pdf");
    const bytes = await Zotero.File.getContentsAsync(
      await attachment.getFilePathAsync(),
    );
    assert.equal(String(bytes).slice(0, 5), "%PDF-");

    let rejected = false;
    try {
      await Utils.attachRemotePDF(new URL("https://example.com/"), item);
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected);
    assert.lengthOf(item.getAttachments(), 1);
  });

  it("registers OpenAlex but no Sci-Hub resolver in a fresh profile", function () {
    const raw = Zotero.Prefs.get("extensions.zotero.findPDFs.resolvers", true);
    assert.isString(raw);
    const resolvers = JSON.parse(raw as string) as { name: string }[];
    assert.include(
      resolvers.map((resolver) => resolver.name),
      "OpenAlex",
    );
    assert.notInclude(
      resolvers.map((resolver) => resolver.name),
      "Sci-Hub",
    );
  });
});
