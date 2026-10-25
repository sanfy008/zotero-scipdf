import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { Utils } from "../utils/utils";
import { CustomResolverManager } from "./CustomResolverManager";
import {
  resolveEmail,
  verifyAndRepairItemDOI,
  type DOIRepairReport,
} from "./DOICompleter";
import { enrichSingleItem } from "./MetadataEnricher";
import { runExclusive } from "./OperationGate";
import { LocalPDFIndex } from "./LocalPDFIndex";
import {
  OAResolver,
  extractPdfUrlFromHtml,
  type OACandidate,
} from "./OAResolver";

class PDFNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
    Object.setPrototypeOf(this, PDFNotFoundError.prototype);
  }
}

export class CaptchaBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaBlockedError";
    Object.setPrototypeOf(this, CaptchaBlockedError.prototype);
  }
}

interface FetchState {
  cancelled: boolean;
  cancelRequest?: () => void;
}

export class SciHubFetcher {
  private static readonly pdfNotAvailableRegexes = [
    /Please try to search again using DOI/im,
    /статья не найдена в базе/im,
  ];

  // A desktop browser UA. Publisher landing pages and some mirrors serve
  // different (or no) markup to unknown agents.
  private static readonly userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  static async updateItems(
    items: Zotero.Item[],
    skipIfExistPDF: boolean = true,
  ) {
    const filtered: Zotero.Item[] = [];
    for (const item of items) {
      if (!item.isRegularItem()) {
        continue;
      }
      if (!skipIfExistPDF) {
        filtered.push(item);
        continue;
      }
      const attachment = await item.getBestAttachment();
      if (!attachment || !attachment.isPDFAttachment()) {
        filtered.push(item);
      }
    }

    if (filtered.length <= 0) {
      return;
    }

    await runExclusive(() => this.runFetch(filtered));
  }

  private static async runFetch(filtered: Zotero.Item[]): Promise<void> {
    const state: FetchState = { cancelled: false, cancelRequest: undefined };
    // Do not retry a throttled host again in this batch.
    const throttledHosts = new Set<string>();
    const email = resolveEmail((getPref("email") as string) || "");

    // One pass over the library, then every item is matched locally. Building
    // this up front costs one scan per batch, not one per item.
    let localIndex: LocalPDFIndex | undefined;
    if (getPref("reuseLocalPDF") !== false && filtered.length > 0) {
      try {
        localIndex = await LocalPDFIndex.build(filtered[0].libraryID);
      } catch (error) {
        Zotero.debug(`[Sci-PDF] local PDF index failed: ${String(error)}`);
      }
    }

    for (const [itemIndex, item] of filtered.entries()) {
      if (state.cancelled) break;

      const doiReport = await this.ensureValidDOI(item, email);

      // Reuse a PDF that is already in the library instead of downloading and
      // storing a second copy of the same file.
      if (localIndex && (await this.reuseLocalPDF(item, localIndex, state))) {
        continue;
      }

      const dois = await Utils.extractDOIs(item);
      const arxivIds = await Utils.extractArXivIDs(item);
      if (!dois.length && !arxivIds.length) {
        Utils.showPopWin(
          getString("popwin-doimissing"),
          item.getDisplayTitle(),
          "fail",
        );
        continue;
      }

      const win = Utils.showPopWin(
        getString("popwin-fetching"),
        item.getDisplayTitle(),
        "default",
        0,
      );
      win.addDescription(getString("popwin-cancelhint"));
      const close = win.win.close.bind(win.win);
      // Zotero's close-on-click calls this method. Programmatic cleanup uses close directly.
      win.win.close = () => {
        state.cancelled = true;
        state.cancelRequest?.();
        close();
      };

      let success = false;
      let oaHadCandidates = false;
      let sciHubRan = false;
      let sciHubAllNotFound = true;
      try {
        // 1) Legal open-access sources first (arXiv / Unpaywall / Semantic Scholar /
        //    OpenAlex). These are not network-blocked and cover most OA papers.
        if (this.anyOASourceEnabled()) {
          let candidates: OACandidate[] = [];
          const targetDoi = dois.length > 0 ? dois[0] : "";
          const targetArxiv = arxivIds.length > 0 ? arxivIds[0] : null;
          const itemTitle = item.getField("title") || null;
          try {
            candidates = await OAResolver.resolve(
              targetDoi,
              email,
              targetArxiv,
              itemTitle,
            );
          } catch (error) {
            Zotero.debug(`[Sci-PDF] OA resolve failed: ${String(error)}`);
          }
          oaHadCandidates = candidates.length > 0;
          if (!state.cancelled) {
            success = await this.tryOACandidates(candidates, item, state, win);
          }
        }

        // 2) Sci-Hub fallback — opt-in only (unreliable / often blocked).
        if (!success && !state.cancelled && getPref("scihubEnabled") === true) {
          sciHubRan = true;
          const result = await this.fetchViaSciHub(
            item,
            state,
            win,
            itemIndex,
            filtered.length,
            throttledHosts,
          );
          success = result.success;
          sciHubAllNotFound = result.allNotFound;
        }
      } finally {
        win.win.close = close;
        close();
      }

      if (state.cancelled) {
        Utils.showPopWin(getString("popwin-cancelled"), item.getDisplayTitle());
        break;
      }

      // "Not available" = nothing anywhere offered a PDF link. "Failed" = we had
      // links (OA candidates or a reachable mirror) but could not download one.
      const downloadFailed =
        (oaHadCandidates && !success) || (sciHubRan && !sciHubAllNotFound);
      const resultKey = success
        ? "popwin-fetchsuccess"
        : downloadFailed
          ? "popwin-fetchfailed"
          : "popwin-pdfnotavaliable";
      Utils.showPopWin(
        getString(resultKey),
        item.getDisplayTitle(),
        success ? "success" : "fail",
        5000,
      );

      // Fallback: If PDF was not available / failed and user enabled auto-enrichment,
      // enrich item metadata & abstract from OpenAlex/Crossref.
      if (
        !success &&
        !state.cancelled &&
        getPref("autoEnrichMetadata") !== false
      ) {
        try {
          const enrichReport = await enrichSingleItem(item, email, doiReport);
          if (enrichReport.outcome === "enriched") {
            Utils.showPopWin(
              getString("popwin-fallback-enriched"),
              `${item.getDisplayTitle()} → +${enrichReport.updatedFields.join(", ")}`,
              "success",
              4000,
            );
          }
        } catch (enrichErr) {
          Zotero.debug(
            `[Sci-PDF] Fallback metadata enrichment error: ${String(enrichErr)}`,
          );
        }
      }
    }
  }

  /**
   * Attaches an existing library PDF to `item` as a linked file. Returns true
   * when the item now has a PDF and the caller should skip the download.
   */
  private static async reuseLocalPDF(
    item: Zotero.Item,
    index: LocalPDFIndex,
    state: FetchState,
  ): Promise<boolean> {
    if (state.cancelled) return false;
    const match = index.find(item);
    if (!match?.filePath) return false;
    const linked = await Utils.linkExistingPDF(item, match.filePath);
    if (!linked) return false;
    Utils.showPopWin(
      getString("popwin-reusedlocal", {
        args: {
          source: match.parent.getField("title") || "",
          evidence: match.evidence,
        },
      }),
      item.getDisplayTitle(),
      "success",
      5000,
    );
    return true;
  }

  private static anyOASourceEnabled(): boolean {
    return (
      getPref("unpaywall") !== false ||
      getPref("semanticScholar") !== false ||
      getPref("openAlex") !== false ||
      getPref("arxiv") !== false
    );
  }

  // Validates the item's DOI and, when it is missing or provably nonexistent,
  // derives the correct one from the title (via Crossref) and writes it back.
  // A large share of imported / AI-generated references carry fabricated DOIs;
  // correcting them is what lets every downstream resolver work at all.
  // Only ever runs from the explicit right-click action.
  private static async ensureValidDOI(
    item: Zotero.Item,
    email: string,
  ): Promise<DOIRepairReport | undefined> {
    if (getPref("completeDOI") === false) {
      return undefined;
    }
    try {
      const report = await verifyAndRepairItemDOI(item, email);
      if (report.outcome === "completed") {
        Utils.showPopWin(
          getString("popwin-doicompleted"),
          `${item.getDisplayTitle()} → ${report.newDOI}`,
          "success",
        );
      } else if (report.outcome === "repaired") {
        const title =
          report.detail === "mismatched"
            ? getString("popwin-doimismatched")
            : getString("popwin-doifixed");
        Utils.showPopWin(
          title,
          `${report.oldDOI || item.getDisplayTitle()} → ${report.newDOI}`,
          "success",
        );
      }
      return report;
    } catch (error) {
      Zotero.debug(`[Sci-PDF] failed to ensure valid DOI: ${String(error)}`);
      return undefined;
    }
  }

  // Walks the ordered OA candidates, attaching the first PDF that downloads.
  // Direct-PDF candidates are attached as-is; landing pages are scraped for a
  // `citation_pdf_url` first.
  private static async tryOACandidates(
    candidates: OACandidate[],
    item: Zotero.Item,
    state: FetchState,
    win: ReturnType<typeof Utils.showPopWin>,
  ): Promise<boolean> {
    for (const [index, candidate] of candidates.entries()) {
      if (state.cancelled) return false;
      win.changeLine({
        text: getString("popwin-oaprogress", {
          args: { source: candidate.source, title: item.getDisplayTitle() },
        }),
        progress: (index / candidates.length) * 100,
      });
      try {
        let pdfUrl: string | null = candidate.url;
        if (candidate.kind === "landing") {
          const html = await this.fetchText(candidate.url, state);
          if (state.cancelled) return false;
          pdfUrl = extractPdfUrlFromHtml(html, candidate.url);
        }
        if (!pdfUrl) continue;
        await Utils.attachRemotePDF(new URL(pdfUrl), item);
        if (state.cancelled) return false;
        return true;
      } catch (error) {
        if (state.cancelled) return false;
        Zotero.debug(
          `[Sci-PDF] OA candidate ${candidate.url} failed: ${String(error)}`,
        );
      } finally {
        state.cancelRequest = undefined;
      }
    }
    return false;
  }

  private static async fetchText(
    url: string,
    state: FetchState,
  ): Promise<string> {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "text",
      timeout: 15000,
      errorDelayMax: 0,
      successCodes: false,
      cancellerReceiver: (cancel: () => void) => {
        state.cancelRequest = cancel;
        if (state.cancelled) cancel();
      },
      headers: { "User-Agent": this.userAgent },
    });
    state.cancelRequest = undefined;
    if (xhr.status < 200 || xhr.status >= 300) {
      throw Object.assign(new Error(`HTTP ${xhr.status} ${xhr.statusText}`), {
        status: xhr.status,
      });
    }
    return (xhr.responseText as string) || "";
  }

  // Iterates the configured Sci-Hub mirrors for one item, scraping each for the
  // embedded PDF. Returns whether a PDF was attached, and whether every mirror
  // explicitly reported the article as unavailable (vs. errored/throttled).
  private static async fetchViaSciHub(
    item: Zotero.Item,
    state: FetchState,
    win: ReturnType<typeof Utils.showPopWin>,
    itemIndex: number,
    itemsTotal: number,
    throttledHosts: Set<string>,
  ): Promise<{ success: boolean; allNotFound: boolean }> {
    const scihubUrls = await this.buildSciHubURLs(item);
    if (!scihubUrls.length) {
      return { success: false, allNotFound: true };
    }
    let success = false;
    let allNotFound = true;
    for (const [mirrorIndex, scihubUrl] of scihubUrls.entries()) {
      if (state.cancelled) break;
      if (throttledHosts.has(scihubUrl.host)) {
        allNotFound = false;
        continue;
      }
      win.changeLine({
        text: getString("popwin-fetchprogress", {
          args: {
            item: itemIndex + 1,
            items: itemsTotal,
            mirror: mirrorIndex + 1,
            mirrors: scihubUrls.length,
            host: scihubUrl.host,
            title: item.getDisplayTitle(),
          },
        }),
        progress: (mirrorIndex / scihubUrls.length) * 100,
      });
      try {
        await this.fetchPDF(scihubUrl, item, state);
        success = !state.cancelled;
        break;
      } catch (error) {
        if (state.cancelled) break;
        const status = (error as { status?: number } | null)?.status;
        const isCaptcha = error instanceof CaptchaBlockedError;
        // Status 0 (network/DNS unreachable), 403 (Cloudflare block), 429 (rate-limit),
        // 503 (service unavailable), or CAPTCHA challenge: throttle mirror for rest of batch.
        if (
          status === 0 ||
          status === 403 ||
          status === 429 ||
          status === 503 ||
          isCaptcha
        ) {
          throttledHosts.add(scihubUrl.host);
          Zotero.debug(
            `[Sci-PDF] Mirror ${scihubUrl.host} throttled/blocked for current batch (status: ${status}, captcha: ${isCaptcha})`,
          );
        }
        allNotFound &&= error instanceof PDFNotFoundError;
        Zotero.debug(`[Sci-PDF] ${scihubUrl.href}: ${String(error)}`);
      } finally {
        state.cancelRequest = undefined;
      }
    }
    return { success, allNotFound };
  }

  private static async buildSciHubURLs(item: Zotero.Item): Promise<URL[]> {
    const dois = await Utils.extractDOIs(item);
    const baseURLs = this.baseSciHubURLs;
    const urls: URL[] = [];
    for (const doi of dois) {
      for (const base of baseURLs) {
        try {
          urls.push(new URL(doi, base));
        } catch {
          // skip invalid URLs
        }
      }
    }
    return urls;
  }

  private static get baseSciHubURLs(): string[] {
    // Only Sci-Hub resolvers are HTML mirrors this scraper understands. Other
    // resolvers (e.g. the OpenAlex JSON API) must not be treated as mirrors.
    const sciHubResolvers = CustomResolverManager.shared.customResolvers.filter(
      (r) => r.name === "Sci-Hub",
    );
    if (sciHubResolvers.length <= 0) {
      return ["https://sci-hub.se/"];
    }
    return sciHubResolvers.map((r) => {
      // resolver.url is like "https://sci-hub.se/{doi}", extract the base
      return r.url.replace(/\{doi\}.*$/, "");
    });
  }

  private static isCaptchaChallenge(html?: string): boolean {
    if (!html) return false;
    return (
      html.includes("altcha-widget") ||
      html.includes("challengeurl=") ||
      html.includes('id="isrobot"') ||
      html.includes("altcha.min.js") ||
      html.includes('action="/captcha') ||
      html.includes("g-recaptcha") ||
      html.includes("cf-challenge") ||
      html.includes("challenges.cloudflare.com")
    );
  }

  private static extractSciHubPdfUrl(doc: Document | null): string | null {
    if (!doc || typeof doc.querySelector !== "function") return null;

    // 1. #pdf element src
    try {
      const elPdf = doc.querySelector("#pdf");
      if (elPdf && typeof elPdf.getAttribute === "function") {
        const src = elPdf.getAttribute("src");
        if (src && src.trim()) return src.trim();
      }
    } catch {
      // ignore
    }

    // 2. embed/iframe with application/pdf or .pdf in src
    try {
      const embedPdf = doc.querySelector(
        "embed[type='application/pdf'], embed[src*='.pdf'], iframe[src*='.pdf']",
      );
      if (embedPdf && typeof embedPdf.getAttribute === "function") {
        const src = embedPdf.getAttribute("src");
        if (src && src.trim()) return src.trim();
      }
    } catch {
      // ignore
    }

    // 3. Download button with onclick="location.href='//...pdf'" or similar
    try {
      const btn = doc.querySelector(
        "#buttons button[onclick*='location.href'], #buttons button[onclick*='.pdf']",
      );
      if (btn && typeof btn.getAttribute === "function") {
        const onclick = btn.getAttribute("onclick") || "";
        const match =
          onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
          onclick.match(/['"](https?:)?\/\/[^'"]+\.pdf[^'"]*['"]/i);
        if (match && match[1]) return match[1].trim();
      }
    } catch {
      // ignore
    }

    // 4. Download link inside #buttons or main container
    try {
      const link = doc.querySelector(
        "#buttons a[href*='.pdf'], a[href*='/downloads/'], a[href*='download=true']",
      );
      if (link && typeof link.getAttribute === "function") {
        const href = link.getAttribute("href");
        if (href && href.trim()) return href.trim();
      }
    } catch {
      // ignore
    }

    return null;
  }

  private static async fetchPDF(
    scihubUrl: URL,
    item: Zotero.Item,
    state: FetchState,
  ) {
    const xhr = await Zotero.HTTP.request("GET", scihubUrl.href, {
      responseType: "document",
      timeout: 15000,
      errorDelayMax: 0,
      // Handle status codes ourselves, avoiding automatic Retry-After waits on Z7 too.
      successCodes: false,
      cancellerReceiver: (cancel: () => void) => {
        state.cancelRequest = cancel;
        if (state.cancelled) cancel();
      },
      headers: {
        "User-Agent": this.userAgent,
      },
    });
    state.cancelRequest = undefined;
    if (state.cancelled) return;
    if (xhr.status !== 200) {
      throw Object.assign(new Error(`HTTP ${xhr.status} ${xhr.statusText}`), {
        status: xhr.status,
      });
    }

    const doc = xhr.responseXML as Document | null;
    const htmlText = String(
      doc?.documentElement?.innerHTML || xhr.responseText || "",
    );

    if (this.isCaptchaChallenge(htmlText)) {
      throw new CaptchaBlockedError(
        `Sci-Hub mirror ${scihubUrl.host} returned a CAPTCHA / bot challenge`,
      );
    }

    const rawPDFUrl = this.extractSciHubPdfUrl(doc);
    const body = doc?.querySelector("body");

    if (rawPDFUrl) {
      // new URL() handles absolute, protocol-relative, root-relative,
      // and relative paths correctly using scihubUrl as the base.
      const pdfUrl = new URL(rawPDFUrl, scihubUrl.href);
      if (pdfUrl.protocol === "http:" || !pdfUrl.protocol) {
        pdfUrl.protocol = "https:";
      }
      await Utils.attachRemotePDF(pdfUrl, item);
    } else if (this.pdfNotAvailable(body)) {
      ztoolkit.log(`scihub: PDF is not available at the moment "${scihubUrl}"`);
      throw new PDFNotFoundError(`PDF is not available: ${scihubUrl}`);
    } else {
      ztoolkit.log(`scihub: failed to fetch PDF from "${scihubUrl}"`);
      throw new Error(xhr.statusText || "No PDF found in mirror markup");
    }
  }

  private static pdfNotAvailable(body?: Element | null): boolean {
    const innerHTML = (body as HTMLElement)?.innerHTML as string | undefined;
    if (!innerHTML || innerHTML.trim() === "") {
      return true;
    }
    return this.pdfNotAvailableRegexes.some((regex) => regex.test(innerHTML));
  }
}
