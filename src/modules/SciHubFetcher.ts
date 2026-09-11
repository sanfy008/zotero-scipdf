import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { Utils } from "../utils/utils";
import { CustomResolverManager } from "./CustomResolverManager";
import { verifyAndRepairItemDOI } from "./DOICompleter";
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

    const state: FetchState = { cancelled: false, cancelRequest: undefined };
    // Do not retry a throttled host again in this batch.
    const throttledHosts = new Set<string>();
    const email = (getPref("email") as string) || "";

    for (const [itemIndex, item] of filtered.entries()) {
      if (state.cancelled) break;

      await this.ensureValidDOI(item, email);
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
            success = await this.tryOACandidates(
              candidates,
              item,
              state,
              win,
            );
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
    }
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
  ): Promise<void> {
    if (getPref("completeDOI") === false) {
      return;
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
    } catch (error) {
      Zotero.debug(`[Sci-PDF] failed to ensure valid DOI: ${String(error)}`);
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
    if (xhr.status !== 200) {
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
        if (status === 429 || status === 503)
          throttledHosts.add(scihubUrl.host);
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
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
      },
    });
    state.cancelRequest = undefined;
    if (state.cancelled) return;
    if (xhr.status !== 200) {
      throw Object.assign(new Error(`HTTP ${xhr.status} ${xhr.statusText}`), {
        status: xhr.status,
      });
    }
    const rawPDFUrl = xhr.responseXML
      ?.querySelector("#pdf")
      ?.getAttribute("src");
    const body = xhr.responseXML?.querySelector("body");

    if (xhr.status === 200 && rawPDFUrl) {
      // new URL() handles absolute, protocol-relative, root-relative,
      // and relative paths correctly using scihubUrl as the base.
      const pdfUrl = new URL(rawPDFUrl, scihubUrl.href);
      pdfUrl.protocol = "https:";
      await Utils.attachRemotePDF(pdfUrl, item);
    } else if (xhr.status === 200 && this.pdfNotAvailable(body)) {
      ztoolkit.log(`scihub: PDF is not available at the moment "${scihubUrl}"`);
      throw new PDFNotFoundError(`PDF is not available: ${scihubUrl}`);
    } else {
      ztoolkit.log(`scihub: failed to fetch PDF from "${scihubUrl}"`);
      throw new Error(xhr.statusText);
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
