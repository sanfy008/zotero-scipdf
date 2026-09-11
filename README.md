# SciPDF For Zotero

[![zotero target version](https://img.shields.io/badge/Zotero-7+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

English | [简体中文](doc/README-zhCN.md)


# Introduction
This plugin helps Zotero find and download full-text PDFs from multiple sources.
It utilizes Zotero's built-in [PDF resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers) feature, writing resolvers into the `extensions.zotero.findPDFs.resolvers` field so that Zotero's **Find Available PDF** (and automatic download of newly added items) can fetch PDFs.

Two sources are configured out of the box:
- **OpenAlex** (enabled by default) — a legal, open-access source. It aggregates OA copies from publishers and repositories and often finds full text (including recent papers) that Sci-Hub does not have. When there is no direct PDF link, it hands Zotero the article's landing page so Zotero's translators can reach the PDF.
- **Sci-Hub** — a fallback for older paywalled papers. Ships with the reliably-reachable mirrors (`sci-hub.se`, `sci-hub.st`, `sci-hub.ru`).

OpenAlex is tried before Sci-Hub. Both can be toggled and configured in the plugin's preferences; you may optionally set a contact email for OpenAlex (recommended, for the API's "polite pool").

**Missing-DOI completion** (enabled by default): when you fetch manually via the right-click menu, an item that has no DOI is looked up on Crossref by its title (corroborated by first author and year). On a confident match the DOI is filled in and the fetch proceeds normally. This runs only on the explicit right-click action — never during background auto-download — and can be turned off in preferences.

> [Detail code in Zotero](https://github.com/zotero/zotero/blob/5536f8d2bd08ddac9074b9df05b7d205273835e7/chrome/content/zotero/xpcom/attachments.js#L1350)  
> [Custom PDF resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers)  
> [Zotero Chinese user guide](https://zotero-chinese.com/user-guide/plugins/Zotero-scihub.html#操作步骤)  

# Usage
Download and install the [latest release xpi file](https://github.com/syt2/zotero-scipdf/releases/latest/download/sci-pdf.xpi).

- For items missing attachments prior to the installation of the plugin, right-click on the item and click on `Find Full Text`.
- For newly added items with a `DOI`, if the `Automatically download PDFs` option is enabled in the preferences, Zotero will attempt to download the attachments automatically.

### Add/Remove Sci-Hub Sites
Upon first installation, the plugin will come pre-configured with some common Sci-Hub sites. If you need to add other Sci-Hub sites or remove existing ones, you can edit them in the plugin's settings. Different sites can be separated by commas `,`.

# FAQs
- Both OpenAlex and Sci-Hub resolvers require a `DOI`: Zotero only runs custom PDF resolvers for items that have a DOI. Items without a DOI can still be tried via Zotero's own resolvers (item URL / Zotero's OA index), but not via these resolvers. When you fetch manually, the missing-DOI completion above can fill in a DOI first so these resolvers become usable.
- Items that already have associated attachments do not show the `Find Full Text` option; use the plugin's right-click menu to force a fetch.
