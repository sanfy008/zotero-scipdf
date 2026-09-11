// Legal open-access resolver chain. Given a DOI or arXiv identifier, query
// OA aggregators (arXiv, Unpaywall, Semantic Scholar, OpenAlex) and return an
// ordered list of candidate URLs: direct PDFs first, then landing pages we can
// scrape for a `citation_pdf_url`. None of these sources are blocked in the way
// Sci-Hub is, and they complement each other — a copy missing from one is often
// indexed by another — so we merge all of them rather than stopping at the first hit.
import { getPref } from "../utils/prefs";
import { titleSimilarity, TITLE_SIMILARITY_THRESHOLD } from "./DOICompleter";

export interface OACandidate {
  url: string;
  kind: "pdf" | "landing";
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// --- Response parsers (pure, unit-tested) ---

export function buildArXivDirectCandidate(arxivId: string): OACandidate {
  const clean = arxivId
    .replace(/\.pdf$/i, "")
    .replace(/[.,;:()[\]]+$/, "")
    .trim();
  return {
    url: `https://arxiv.org/pdf/${clean}.pdf`,
    kind: "pdf",
    source: "arXiv",
  };
}

export function parseUnpaywall(json: unknown): OACandidate[] {
  const root = asRecord(json);
  if (!root) return [];
  const out: OACandidate[] = [];
  const pushLoc = (locValue: unknown) => {
    const loc = asRecord(locValue);
    if (!loc) return;
    const pdf = asString(loc.url_for_pdf);
    if (pdf) out.push({ url: pdf, kind: "pdf", source: "Unpaywall" });
    const landing = asString(loc.url);
    if (landing) out.push({ url: landing, kind: "landing", source: "Unpaywall" });
  };
  pushLoc(root.best_oa_location);
  if (Array.isArray(root.oa_locations)) root.oa_locations.forEach(pushLoc);
  return out;
}

export function parseSemanticScholar(json: unknown): OACandidate[] {
  const root = asRecord(json);
  if (!root) return [];
  const out: OACandidate[] = [];
  const oa = asRecord(root.openAccessPdf);
  const pdf = oa && asString(oa.url);
  if (pdf) out.push({ url: pdf, kind: "pdf", source: "Semantic Scholar" });

  const ext = asRecord(root.externalIds);
  const arxiv = ext && asString(ext.ArXiv);
  if (arxiv) {
    const cleanArxiv = arxiv.replace(/v\d+$/i, "").trim();
    out.push({
      url: `https://arxiv.org/pdf/${cleanArxiv}.pdf`,
      kind: "pdf",
      source: "Semantic Scholar (arXiv)",
    });
  }
  return out;
}

export function parseOpenAlexOA(json: unknown): OACandidate[] {
  const root = asRecord(json);
  if (!root) return [];
  const out: OACandidate[] = [];
  const pushLoc = (locValue: unknown) => {
    const loc = asRecord(locValue);
    if (!loc) return;
    const pdf = asString(loc.pdf_url);
    if (pdf) out.push({ url: pdf, kind: "pdf", source: "OpenAlex" });
    const landing = asString(loc.landing_page_url);
    if (landing) out.push({ url: landing, kind: "landing", source: "OpenAlex" });
  };
  pushLoc(root.best_oa_location);
  if (Array.isArray(root.locations)) root.locations.forEach(pushLoc);
  const oa = asRecord(root.open_access);
  const oaUrl = oa && asString(oa.oa_url);
  if (oaUrl) out.push({ url: oaUrl, kind: "landing", source: "OpenAlex" });
  return out;
}

export function parseArXivFeed(
  xml: string,
  targetTitle?: string,
): OACandidate[] {
  if (!xml) return [];
  const out: OACandidate[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const candTitle = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

    if (targetTitle && candTitle) {
      const sim = titleSimilarity(targetTitle, candTitle);
      if (sim < TITLE_SIMILARITY_THRESHOLD) continue;
    }

    const pdfLinkMatch =
      /<link[^>]+(?:title=["']pdf["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*title=["']pdf["'])/i.exec(
        block,
      );
    let pdfUrl = pdfLinkMatch ? (pdfLinkMatch[1] || pdfLinkMatch[2]) : null;

    if (!pdfUrl) {
      const idMatch =
        /<id>[\s\S]*?arxiv\.org\/abs\/([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)[\s\S]*?<\/id>/i.exec(
          block,
        );
      if (idMatch && idMatch[1]) {
        pdfUrl = `https://arxiv.org/pdf/${idMatch[1]}.pdf`;
      }
    }

    if (pdfUrl) {
      if (!pdfUrl.endsWith(".pdf")) pdfUrl += ".pdf";
      if (pdfUrl.startsWith("http://")) pdfUrl = "https://" + pdfUrl.slice(7);
      out.push({ url: pdfUrl, kind: "pdf", source: "arXiv (Preprint)" });
    }
  }
  return out;
}

// Direct-PDF candidates first (they need no scraping), then landing pages.
// De-duplicate by URL while preserving the source-priority order of the input.
export function orderCandidates(candidates: OACandidate[]): OACandidate[] {
  const seen = new Set<string>();
  const pdfs: OACandidate[] = [];
  const landings: OACandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    (candidate.kind === "pdf" ? pdfs : landings).push(candidate);
  }
  return [...pdfs, ...landings];
}

// Extract a PDF URL from a landing page's HTML. Publishers and repositories
// almost universally expose the full-text link via a `citation_pdf_url` meta
// tag (the same signal Google Scholar and Zotero's own resolver rely on); we
// also accept an explicit `application/pdf` <link>. Returns an absolute URL.
export function extractPdfUrlFromHtml(
  html: string,
  baseUrl: string,
): string | null {
  if (!html) return null;
  const patterns = [
    /<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']/i,
    /<meta[^>]+property=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i,
    /<link[^>]+type=["']application\/pdf["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/pdf["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const found = match?.[1];
    if (found) {
      try {
        return new URL(found, baseUrl).href;
      } catch {
        return found;
      }
    }
  }
  return null;
}

export class OAResolver {
  // Runs every enabled source in parallel; a failing source contributes nothing
  // rather than aborting the others.
  static async resolve(
    doi: string,
    email: string,
    arxivId?: string | null,
    title?: string | null,
  ): Promise<OACandidate[]> {
    const trimmedEmail = email.trim();
    const tasks: Promise<OACandidate[]>[] = [];
    const directCandidates: OACandidate[] = [];

    // 1. Direct arXiv identifier if known or derived from DOI
    let targetArXiv = arxivId ? arxivId.trim() : null;
    if (!targetArXiv && doi && /^10\.48550\/arXiv\./i.test(doi.trim())) {
      targetArXiv = doi.trim().replace(/^10\.48550\/arXiv\./i, "");
    }
    if (targetArXiv && getPref("arxiv") !== false) {
      directCandidates.push(buildArXivDirectCandidate(targetArXiv));
    }

    // 2. Query aggregators if DOI is available
    const cleanDOI = doi.trim();
    if (cleanDOI) {
      // Unpaywall mandates a contact email; skip it when none is configured.
      if (getPref("unpaywall") !== false && trimmedEmail) {
        tasks.push(this.fromUnpaywall(cleanDOI, trimmedEmail));
      }
      if (getPref("semanticScholar") !== false) {
        tasks.push(this.fromSemanticScholar(cleanDOI));
      }
      if (getPref("openAlex") !== false) {
        tasks.push(this.fromOpenAlex(cleanDOI, trimmedEmail));
      }
    }

    // 3. arXiv title search fallback if title is present and no direct arXiv ID
    if (!targetArXiv && title && getPref("arxiv") !== false) {
      tasks.push(this.fromArXivByTitle(title));
    }

    const results = await Promise.all(
      tasks.map((task) =>
        task.catch((error) => {
          Zotero.debug(`[Sci-PDF] OA source failed: ${String(error)}`);
          return [] as OACandidate[];
        }),
      ),
    );
    return orderCandidates([...directCandidates, ...results.flat()]);
  }

  private static async getJSON(url: string): Promise<unknown> {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 20000,
      successCodes: false,
      headers: {
        "User-Agent": "zotero-scipdf (https://github.com/syt2/zotero-scipdf)",
      },
    });
    if (xhr.status !== 200) return null;
    const data = xhr.response;
    if (typeof data === "string") {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return data;
  }

  private static async fromUnpaywall(
    doi: string,
    email: string,
  ): Promise<OACandidate[]> {
    const url = `https://api.unpaywall.org/v2/${doi}?email=${encodeURIComponent(
      email,
    )}`;
    return parseUnpaywall(await this.getJSON(url));
  }

  private static async fromSemanticScholar(
    doi: string,
  ): Promise<OACandidate[]> {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=isOpenAccess,openAccessPdf,externalIds`;
    return parseSemanticScholar(await this.getJSON(url));
  }

  private static async fromOpenAlex(
    doi: string,
    email: string,
  ): Promise<OACandidate[]> {
    const mailto = email ? `?mailto=${encodeURIComponent(email)}` : "";
    const url = `https://api.openalex.org/works/doi:${doi}${mailto}`;
    return parseOpenAlexOA(await this.getJSON(url));
  }

  private static async fromArXivByTitle(
    title: string,
  ): Promise<OACandidate[]> {
    if (!title || !title.trim()) return [];
    const clean = title
      .replace(/<[^>]*>/g, " ")
      .replace(/[:\-–—?]/g, " ")
      .replace(/["'“‘”’]/g, "")
      .trim();
    if (clean.length < 5) return [];
    const url = `https://export.arxiv.org/api/query?search_query=ti:%22${encodeURIComponent(
      clean,
    )}%22&max_results=3`;
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        responseType: "text",
        timeout: 15000,
        headers: {
          "User-Agent": "zotero-scipdf (https://github.com/syt2/zotero-scipdf)",
        },
      });
      if (xhr.status !== 200 || !xhr.response) return [];
      return parseArXivFeed(String(xhr.response), title);
    } catch (error) {
      Zotero.debug(`[Sci-PDF] arXiv title search failed: ${String(error)}`);
      return [];
    }
  }
}
