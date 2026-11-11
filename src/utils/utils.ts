import { matchDOIs, matchArXivIDs } from "./identifierPatterns";

// Tolerate a short run of whitespace/BOM before the signature.
function looksLikePDF(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  let offset = 0;
  while (offset < limit) {
    const byte = bytes[offset];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      break;
    }
    offset++;
  }
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export class Utils {
  static async extractDOIs(item: Zotero.Item): Promise<string[]> {
    // A valid explicit DOI takes precedence over references in title/extra.
    const explicitDOI = item.getField("DOI");
    if (typeof explicitDOI === "string") {
      const matches = matchDOIs(explicitDOI.trim());
      if (matches.length) return matches;
    }
    const dois: string[] = [];

    const extract = (text: string) => {
      for (const doi of matchDOIs(text)) {
        if (!dois.some((value) => value.toLowerCase() === doi.toLowerCase())) {
          dois.push(doi);
        }
      }
    };

    const extractFromItem = (it: Zotero.Item) => {
      for (const field of ["DOI", "url", "title", "extra"] as const) {
        const value = it.getField(field);
        if (value && typeof value === "string") {
          extract(value);
        }
      }
    };

    extractFromItem(item);
    for (const attachment of await item.getBestAttachments()) {
      extractFromItem(attachment);
    }
    return dois;
  }

  static async extractArXivIDs(item: Zotero.Item): Promise<string[]> {
    const arxivIds: string[] = [];
    const extract = (text: string) => {
      for (const id of matchArXivIDs(text)) {
        if (!arxivIds.some((v) => v.toLowerCase() === id.toLowerCase())) {
          arxivIds.push(id);
        }
      }
    };

    const extractFromItem = (it: Zotero.Item) => {
      for (const field of [
        "DOI",
        "url",
        "title",
        "extra",
        "publicationTitle",
      ] as const) {
        try {
          const value = it.getField(field as any);
          if (value && typeof value === "string") {
            extract(value);
          }
        } catch {
          // ignore fields not present on some item types
        }
      }
    };

    extractFromItem(item);
    try {
      for (const attachment of await item.getBestAttachments()) {
        extractFromItem(attachment);
      }
    } catch {
      // ignore
    }
    return arxivIds;
  }

  /**
   * Downloads the candidate first and imports those exact bytes only after
   * checking the PDF signature. A publisher error page, a login wall, or a
   * citation link that happens to end in `.pdf` otherwise becomes a bogus
   * "successful" attachment.
   */
  static async attachRemotePDF(
    pdfURL: URL,
    item: Zotero.Item,
    state?: { cancelled: boolean; cancelRequest?: () => void },
  ) {
    const bytes = await this.downloadBytes(pdfURL, state);
    if (state?.cancelled) return;
    if (!looksLikePDF(bytes)) {
      throw new Error(`Response from ${pdfURL.host} is not a PDF`);
    }

    const tmp = Zotero.getTempDirectory();
    tmp.append(
      `scipdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`,
    );
    // putContentsAsync needs an existing destination file.
    if (
      typeof (tmp as unknown as { createUnique?: unknown }).createUnique ===
      "function"
    ) {
      (
        tmp as unknown as { createUnique: (type: number, mode: number) => void }
      ).createUnique(0, 0o600);
    }
    let decodedName = pdfURL.pathname.split("/").pop() || "";
    try {
      decodedName = decodeURIComponent(decodedName);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
    }
    const filename =
      decodedName
        .replace(/\.pdf$/i, "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 120) || "PDF";
    try {
      // Zotero's putContentsAsync accepts a string, Blob, or input stream;
      // a raw ArrayBuffer is passed to NetUtil.asyncCopy and fails.
      await Zotero.File.putContentsAsync(
        tmp.path,
        new Blob([bytes.buffer as ArrayBuffer], {
          type: "application/pdf",
        }) as unknown as nsIInputStream,
      );
      if (state?.cancelled) return;
      await Zotero.Attachments.importFromFile({
        libraryID: item.libraryID,
        file: tmp.path,
        parentItemID: item.id,
        title: item.getField("title") || filename,
        fileBaseName: filename,
        contentType: "application/pdf",
      });
    } finally {
      try {
        tmp.remove(false);
      } catch {
        // A leftover temp file is harmless.
      }
    }
  }

  private static async downloadBytes(
    url: URL,
    state?: { cancelled: boolean; cancelRequest?: () => void },
  ): Promise<Uint8Array> {
    const maxBytes = 80 * 1024 * 1024;
    const xhr = await Zotero.HTTP.request("GET", url.href, {
      responseType: "arraybuffer",
      timeout: 45000,
      errorDelayMax: 0,
      successCodes: false,
      cancellerReceiver: (cancel: () => void) => {
        if (state) state.cancelRequest = cancel;
        if (state?.cancelled) cancel();
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (state) state.cancelRequest = undefined;
    if (state?.cancelled) throw new Error("Cancelled");
    if (xhr.status < 200 || xhr.status >= 300) {
      throw Object.assign(new Error(`HTTP ${xhr.status} ${xhr.statusText}`), {
        status: xhr.status,
      });
    }
    const response = xhr.response as unknown;
    const isArrayBufferLike =
      Object.prototype.toString.call(response) === "[object ArrayBuffer]" ||
      (response != null &&
        typeof (response as ArrayBuffer).byteLength === "number" &&
        typeof (response as ArrayBuffer).slice === "function" &&
        !ArrayBuffer.isView(response));
    if (isArrayBufferLike) {
      const buffer = response as ArrayBuffer;
      if (buffer.byteLength > maxBytes) {
        throw new Error("PDF exceeds the size limit");
      }
      // Copy into this realm so file APIs accept the buffer.
      return new Uint8Array(new Uint8Array(buffer));
    }
    if (ArrayBuffer.isView(response)) {
      return new Uint8Array(
        response.buffer.slice(
          response.byteOffset,
          response.byteOffset + response.byteLength,
        ),
      );
    }
    // Some hosts hand back a string despite the requested response type.
    // Reading responseText after an arraybuffer request throws in Zotero.
    let text: string | undefined =
      typeof response === "string" ? response : undefined;
    if (text === undefined) {
      try {
        text =
          typeof xhr.responseText === "string" ? xhr.responseText : undefined;
      } catch {
        text = undefined;
      }
    }
    if (typeof text === "string") {
      if (text.length > maxBytes) throw new Error("PDF exceeds the size limit");
      // Binary responses decoded as text map one char to one byte.
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xff;
      }
      return bytes;
    }
    throw new Error("Empty download response");
  }

  /**
   * Adds a linked-file attachment on `item` pointing at an existing PDF on
   * disk, so the same file is reused instead of stored a second time. Returns
   * false when Zotero refuses to link (e.g. a group library, where linked files
   * are not supported) so the caller can fall back to a normal download.
   */
  static async linkExistingPDF(
    item: Zotero.Item,
    filePath: string,
  ): Promise<boolean> {
    try {
      const attachment = await Zotero.Attachments.linkFromFile({
        file: filePath,
        parentItemID: item.id,
        contentType: "application/pdf",
        title: item.getField("title") || "PDF",
      });
      return Boolean(attachment);
    } catch (error) {
      Zotero.debug(`[Sci-PDF] could not link ${filePath}: ${String(error)}`);
      return false;
    }
  }

  static showPopWin(
    title: string,
    message: string,
    type?: "fail" | "success" | "default",
    closeTime: number = 3000,
  ) {
    const win = new ztoolkit.ProgressWindow(title, {
      closeOnClick: true,
      closeTime: closeTime,
    }).createLine({
      text: message,
      type: type,
      progress: 0,
    });
    win.show(closeTime);
    return win;
  }
}
