# SciPDF for Zotero

[English](README.md) | [简体中文](doc/README-zhCN.md)

SciPDF helps Zotero 7–10 find full-text PDFs and fill in missing reference metadata. Install the [latest XPI release](https://github.com/syt2/zotero-scipdf/releases/latest/download/sci-pdf.xpi).

## Use the item context menu

- **Fetch PDF** verifies or repairs the DOI when enabled, tries to reuse a PDF already in the library, and searches enabled open-access sources: arXiv, Unpaywall, Semantic Scholar, and OpenAlex. A download is checked for the PDF signature before it is attached, so a login page or an HTML error page is reported as a failed download instead of becoming an attachment. Sci-Hub is an optional fallback, **off by default**. If no PDF can be attached, optional metadata enrichment fills missing fields instead.
- **Verify & Repair DOI** checks whether the DOI exists and belongs to the selected item. If the DOI is absent or rejected, the plugin looks for a replacement supported by the available title, author, and year evidence. Inconclusive checks leave the DOI unchanged.
- **Fetch Metadata & Abstract** fills empty fields without overwriting existing values. It can also run DOI repair when that preference is enabled.

Local reuse creates a linked attachment, not a second stored copy. Zotero does not sync linked-file contents, and linked files are not supported in group libraries. Moving or deleting the original file may break the link.

## Zotero's native lookup is separate

Zotero's **Find Available PDF** and automatic lookup for new items use Zotero's own workflow. SciPDF supplies [custom DOI-based resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers) for enabled OpenAlex and Sci-Hub sources. Native lookup does not run SciPDF's DOI repair, local reuse, or metadata enrichment pipeline.

In SciPDF preferences, control which sources are used and whether the custom resolvers participate in automatic lookup. Sci-Hub mirror URLs can be edited as a comma-separated list; an empty list sends no mirror requests.
