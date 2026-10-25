// Finds a PDF that is already in the user's library so a fetch can reuse it
// instead of downloading and storing a second copy.
//
// Zotero has no way to share one attachment record between two parent items: an
// attachment belongs to exactly one parent. So "reuse" is implemented two ways,
// chosen by the caller:
//   - skip:  the item itself already has the PDF — nothing to do.
//   - link:  another item owns the file — create a *linked-file* attachment on
//            this item pointing at the same path, so no second copy of the PDF
//            is stored. This only works for stored files that live on disk
//            (stored files are always local; linked files may be on a network
//            share).
//
// Matching is deliberately conservative. A false positive silently attaches the
// wrong paper to someone's reference, so identifiers (DOI/arXiv) are trusted
// outright while titles must clear a high similarity bar and, when a second
// candidate is nearly as good, the match is rejected rather than guessed.
import { cleanDOI } from "../utils/identifierPatterns";
import {
  normalizeTitle,
  titleSimilarity,
  TITLE_SIMILARITY_THRESHOLD,
} from "./DOICompleter";

export interface LocalPDFMatch {
  attachment: Zotero.Item;
  parent: Zotero.Item;
  /** Strongest evidence behind the match, for the progress/diagnostic output. */
  evidence: "doi" | "arxiv" | "title";
  score: number;
  /** Absolute path to the PDF on disk; absent for attachment-only records. */
  filePath?: string;
}

export interface LocalIndexEntry {
  parent: Zotero.Item;
  attachment: Zotero.Item;
  doi?: string;
  arxivId?: string;
  title: string;
  filePath?: string;
}

// Why a corpus-level index instead of a Zotero search: the useful signals are
// the parent's DOI/arXiv id and the attachment's resolved file path, neither of
// which is indexed for cross-field search. One pass over the library builds the
// map, and every item in the batch is then matched locally with no I/O.
export class LocalPDFIndex {
  private byDoi = new Map<string, LocalIndexEntry[]>();
  private byArxiv = new Map<string, LocalIndexEntry[]>();
  private byTitle = new Map<string, LocalIndexEntry[]>();
  private entries: LocalIndexEntry[] = [];

  static async build(libraryID: number): Promise<LocalPDFIndex> {
    const index = new LocalPDFIndex();
    const items = await Zotero.Items.getAll(libraryID, false, false);
    const parents = items.filter(
      (item) => item.isRegularItem() && !item.deleted,
    );
    for (const parent of parents) {
      for (const attachmentID of parent.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment || attachment.deleted) continue;
        if (!attachment.isPDFAttachment()) continue;
        index.add(parent, attachment);
      }
    }
    return index;
  }

  private add(parent: Zotero.Item, attachment: Zotero.Item) {
    const doi =
      cleanDOI(parent.getField("DOI") || "").toLowerCase() || undefined;
    const arxivId = extractArxivId(parent);
    const title = (parent.getField("title") as string) || "";
    const entry: LocalIndexEntry = {
      parent,
      attachment,
      doi,
      arxivId,
      title,
      filePath: resolveFilePath(attachment),
    };
    this.entries.push(entry);
    // Keyed by parent id so an item never matches its own attachment.
    const push = (
      map: Map<string, LocalIndexEntry[]>,
      key: string | undefined,
    ) => {
      if (!key) return;
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    };
    push(this.byDoi, doi);
    push(this.byArxiv, arxivId?.toLowerCase());
    const normalized = normalizeTitle(title);
    if (normalized) push(this.byTitle, normalized);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Finds the best existing PDF for `item` (which should have no attachment of
   * its own), or null. Candidates owned by `item` itself are excluded.
   */
  find(item: Zotero.Item): LocalPDFMatch | null {
    const doi = cleanDOI(item.getField("DOI") || "").toLowerCase();
    const arxivId = extractArxivId(item)?.toLowerCase();
    const title = (item.getField("title") as string) || "";

    // 1. Identifiers are unambiguous — take the first usable one.
    for (const [map, key, evidence] of [
      [this.byDoi, doi, "doi"],
      [this.byArxiv, arxivId, "arxiv"],
    ] as const) {
      if (!key) continue;
      const hit = (map.get(key) || []).find(
        (entry) => entry.parent.id !== item.id && entry.filePath,
      );
      if (hit) {
        return {
          attachment: hit.attachment,
          parent: hit.parent,
          evidence,
          score: 1,
          filePath: hit.filePath,
        };
      }
    }

    // 2. Title fallback. Require a clear margin over the runner-up: two papers
    //    with near-identical titles (a baseline and its follow-up) are exactly
    //    where a silent wrong match would happen.
    const normalized = normalizeTitle(title);
    if (!normalized || normalized.length < 10) return null;
    const candidates: { entry: LocalIndexEntry; score: number }[] = [];
    for (const entry of this.entries) {
      if (entry.parent.id === item.id || !entry.filePath) continue;
      const score = titleSimilarity(title, entry.title);
      if (score >= TITLE_SIMILARITY_THRESHOLD)
        candidates.push({ entry, score });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const runnerUp = candidates[1]?.score ?? 0;
    if (best.score - runnerUp < 0.05) return null;
    return {
      attachment: best.entry.attachment,
      parent: best.entry.parent,
      evidence: "title",
      score: best.score,
      filePath: best.entry.filePath,
    };
  }
}

function extractArxivId(item: Zotero.Item): string | undefined {
  // Imported lazily to keep this module free of the Utils dependency cycle.
  const text = [
    item.getField("DOI"),
    item.getField("url"),
    item.getField("extra"),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const match = text.match(
    /(?:10\.48550\/arXiv\.|arxiv\.org\/(?:abs|pdf)\/|arXiv:\s*)([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})/i,
  );
  return match?.[1];
}

/**
 * Absolute path to an attachment's file, or undefined when it is not on disk.
 * `getFilePath` throws for linked files whose target is missing, so failures
 * degrade to "unusable for linking" rather than aborting the scan.
 */
function resolveFilePath(attachment: Zotero.Item): string | undefined {
  try {
    const path = attachment.getFilePath();
    return typeof path === "string" && path ? path : undefined;
  } catch {
    return undefined;
  }
}
