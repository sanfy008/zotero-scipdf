import { cleanDOI } from "../utils/identifierPatterns";
import { Utils } from "../utils/utils";
import { API_USER_AGENT } from "../utils/constants";
import {
  buildQuery,
  cleanQueryTitle,
  itemFirstAuthorSurname,
  itemYear,
  recordDOIAudit,
  resolveEmail,
  selectBestDOI,
  titleSimilarity,
  verifyAndRepairItemDOI,
  isOpenAlexSearchThrottled,
  throttleOpenAlexSearch,
  requestWithHardTimeout,
  type DOIRepairReport,
  type DOIQuery,
} from "./DOICompleter";

export interface WorkMetadata {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  date?: string | null;
  abstract?: string | null;
  publicationTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  source?: "openalex" | "crossref" | "datacite";
}

export interface EnrichmentReport {
  outcome: "enriched" | "already_complete" | "not_found" | "error" | "skipped";
  itemTitle: string;
  doi?: string;
  updatedFields: string[];
  hasAbstract: boolean;
  message?: string;
}

/**
 * Reconstructs continuous plaintext abstract from OpenAlex abstract_inverted_index.
 * OpenAlex stores abstracts as: { "word": [index0, index1, ...] }
 */
export function reconstructOpenAlexAbstract(
  invertedIndex?: Record<string, number[]> | null,
): string | null {
  if (!invertedIndex || typeof invertedIndex !== "object") return null;
  const entries = Object.entries(invertedIndex);
  if (entries.length === 0) return null;

  let maxPos = -1;
  for (const [, positions] of entries) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (typeof pos === "number" && pos > maxPos) {
          maxPos = pos;
        }
      }
    }
  }

  if (maxPos < 0) return null;

  const words = new Array<string>(maxPos + 1);
  for (const [word, positions] of entries) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (typeof pos === "number" && pos >= 0) {
          words[pos] = word;
        }
      }
    }
  }

  const cleanWords: string[] = [];
  for (let i = 0; i <= maxPos; i++) {
    if (words[i] !== undefined) {
      cleanWords.push(words[i]);
    }
  }

  if (cleanWords.length === 0) return null;
  return cleanWords.join(" ").trim();
}

/**
 * Cleans XML/JATS markup and decodes standard entities from Crossref abstract.
 */
export function cleanCrossrefAbstract(
  rawAbstract?: string | null,
): string | null {
  if (!rawAbstract || typeof rawAbstract !== "string") return null;
  const cleaned = rawAbstract
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Extracts plaintext abstract from DataCite descriptions.
 */
export function cleanDataCiteAbstract(
  descriptions?: Array<{
    description?: string;
    descriptionType?: string;
  }> | null,
): string | null {
  if (!Array.isArray(descriptions) || descriptions.length === 0) return null;
  const absEntry = descriptions.find(
    (d) =>
      (d.descriptionType || "").toLowerCase() === "abstract" &&
      typeof d.description === "string" &&
      d.description.trim().length > 0,
  );
  if (!absEntry || !absEntry.description) return null;
  return absEntry.description
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Caches to eliminate duplicate network calls across batch processing
const openAlexCache = new Map<string, WorkMetadata>();
const crossrefCache = new Map<string, WorkMetadata>();
const dataCiteCache = new Map<string, WorkMetadata>();
const unifiedMetadataCache = new Map<string, WorkMetadata>();

export function clearMetadataEnricherCache(): void {
  openAlexCache.clear();
  crossrefCache.clear();
  dataCiteCache.clear();
  unifiedMetadataCache.clear();
}

/**
 * Queries OpenAlex for a specific DOI and extracts detailed metadata.
 */
export async function fetchOpenAlexMetadata(
  doi: string,
  email = "",
): Promise<WorkMetadata | null> {
  const target = cleanDOI(doi).toLowerCase();
  if (!target) return null;

  if (openAlexCache.has(target)) {
    return openAlexCache.get(target)!;
  }

  try {
    const mailto = resolveEmail(email);
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(target)}${
      mailto ? `?mailto=${encodeURIComponent(mailto)}` : ""
    }`;
    const xhr = await requestWithHardTimeout(
      "GET",
      url,
      {
        responseType: "json",
        headers: {
          "User-Agent": API_USER_AGENT,
        },
      },
      10000,
    );

    if (xhr.status !== 200) return null;
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);

    const record = data as {
      doi?: string;
      title?: string;
      display_name?: string;
      publication_year?: number;
      publication_date?: string;
      abstract_inverted_index?: Record<string, number[]>;
      primary_location?: {
        source?: { display_name?: string };
      };
      host_venue?: { display_name?: string };
      biblio?: {
        volume?: string;
        issue?: string;
        first_page?: string;
        last_page?: string;
      };
      authorships?: Array<{ author?: { display_name?: string } }>;
    };

    const title = record.title || record.display_name;
    const year =
      typeof record.publication_year === "number"
        ? record.publication_year
        : null;
    const date = record.publication_date || (year ? String(year) : null);
    const abstract = reconstructOpenAlexAbstract(
      record.abstract_inverted_index,
    );

    const publicationTitle =
      record.primary_location?.source?.display_name ||
      record.host_venue?.display_name ||
      null;

    const volume = record.biblio?.volume || null;
    const issue = record.biblio?.issue || null;
    let pages: string | null = null;
    if (record.biblio?.first_page && record.biblio?.last_page) {
      pages =
        record.biblio.first_page === record.biblio.last_page
          ? record.biblio.first_page
          : `${record.biblio.first_page}-${record.biblio.last_page}`;
    } else if (record.biblio?.first_page) {
      pages = record.biblio.first_page;
    }

    const authors = (record.authorships || [])
      .map((a) => a.author?.display_name || "")
      .filter((s) => s.length > 0);

    const result: WorkMetadata = {
      doi: target,
      title,
      authors,
      year,
      date,
      abstract,
      publicationTitle,
      volume,
      issue,
      pages,
      source: "openalex",
    };
    openAlexCache.set(target, result);
    return result;
  } catch (error) {
    Zotero.debug(`[Sci-PDF] OpenAlex metadata fetch error: ${String(error)}`);
    return null;
  }
}

/**
 * Queries Crossref works API for a specific DOI and extracts metadata.
 */
export async function fetchCrossrefMetadata(
  doi: string,
  email = "",
): Promise<WorkMetadata | null> {
  const target = cleanDOI(doi).toLowerCase();
  if (!target) return null;

  if (crossrefCache.has(target)) {
    return crossrefCache.get(target)!;
  }

  try {
    const mailto = resolveEmail(email);
    const url = `https://api.crossref.org/works/${encodeURIComponent(target)}${
      mailto ? `?mailto=${encodeURIComponent(mailto)}` : ""
    }`;
    const xhr = await requestWithHardTimeout(
      "GET",
      url,
      {
        responseType: "json",
        headers: {
          "User-Agent": API_USER_AGENT,
        },
      },
      10000,
    );

    if (xhr.status !== 200) return null;
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);

    const msg = (data as { message?: Record<string, unknown> })?.message;
    if (!msg) return null;

    const titleArr = msg.title as string[] | undefined;
    const title = titleArr?.[0];
    const year =
      (msg.issued as { "date-parts"?: number[][] })?.["date-parts"]?.[0]?.[0] ??
      null;

    let date: string | null = null;
    const dateParts = (msg.issued as { "date-parts"?: number[][] })?.[
      "date-parts"
    ]?.[0];
    if (Array.isArray(dateParts) && dateParts.length > 0) {
      date = dateParts.join("-");
    } else if (year) {
      date = String(year);
    }

    const abstract = cleanCrossrefAbstract(msg.abstract as string | undefined);
    const containerArr = (msg["container-title"] as string[]) || [];
    const publicationTitle = containerArr[0] || null;

    const volume = (msg.volume as string) || null;
    const issue = (msg.issue as string) || null;
    const pages = (msg.page as string) || null;

    const authors = (
      (msg.author as Array<{
        family?: string;
        given?: string;
        name?: string;
      }>) || []
    )
      .map((a) =>
        a.given
          ? `${a.given} ${a.family || ""}`.trim()
          : a.name || a.family || "",
      )
      .filter((s) => s.length > 0);

    const result: WorkMetadata = {
      doi: target,
      title,
      authors,
      year,
      date,
      abstract,
      publicationTitle,
      volume,
      issue,
      pages,
      source: "crossref",
    };
    crossrefCache.set(target, result);
    return result;
  } catch (error) {
    Zotero.debug(`[Sci-PDF] Crossref metadata fetch error: ${String(error)}`);
    return null;
  }
}

/**
 * Queries DataCite for a specific DOI (e.g. arXiv preprints, Zenodo).
 */
export async function fetchDataCiteMetadata(
  doi: string,
): Promise<WorkMetadata | null> {
  const target = cleanDOI(doi).toLowerCase();
  if (!target) return null;

  if (dataCiteCache.has(target)) {
    return dataCiteCache.get(target)!;
  }

  try {
    const url = `https://api.datacite.org/dois/${encodeURIComponent(target)}`;
    const xhr = await requestWithHardTimeout(
      "GET",
      url,
      {
        responseType: "json",
        headers: {
          "User-Agent": API_USER_AGENT,
        },
      },
      8000,
    );

    if (xhr.status !== 200) return null;
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);

    const attr = (data as { data?: { attributes?: Record<string, unknown> } })
      ?.data?.attributes;
    if (!attr) return null;

    const titles = attr.titles as Array<{ title?: string }> | undefined;
    const title = titles?.[0]?.title;
    const year =
      typeof attr.publicationYear === "number" ? attr.publicationYear : null;
    const date = year ? String(year) : null;

    const descriptions = attr.descriptions as
      | Array<{ description?: string; descriptionType?: string }>
      | undefined;
    const abstract = cleanDataCiteAbstract(descriptions);

    const container = attr.container as
      | {
          title?: string;
          volume?: string;
          issue?: string;
          firstPage?: string;
          lastPage?: string;
        }
      | undefined;

    const publicationTitle =
      container?.title || (attr.publisher as string) || null;
    const volume = container?.volume || null;
    const issue = container?.issue || null;
    let pages: string | null = null;
    if (container?.firstPage && container?.lastPage) {
      pages =
        container.firstPage === container.lastPage
          ? container.firstPage
          : `${container.firstPage}-${container.lastPage}`;
    } else if (container?.firstPage) {
      pages = container.firstPage;
    }

    const creators = (attr.creators as Array<{ name?: string }>) || [];
    const authors = creators
      .map((c) => c.name || "")
      .filter((s) => s.length > 0);

    const result: WorkMetadata = {
      doi: target,
      title,
      authors,
      year,
      date,
      abstract,
      publicationTitle,
      volume,
      issue,
      pages,
      source: "datacite",
    };
    dataCiteCache.set(target, result);
    return result;
  } catch (error) {
    Zotero.debug(`[Sci-PDF] DataCite metadata fetch error: ${String(error)}`);
    return null;
  }
}

/**
 * Multi-source unified metadata resolution:
 * Cascades through OpenAlex, Crossref, and DataCite, short-circuiting on complete data.
 */
export async function fetchUnifiedMetadata(
  doi: string,
  email = "",
): Promise<WorkMetadata | null> {
  const target = cleanDOI(doi).toLowerCase();
  if (!target) return null;

  if (unifiedMetadataCache.has(target)) {
    return unifiedMetadataCache.get(target)!;
  }

  // Cascading strategy:
  // 1. Query OpenAlex first (structured abstract inverted index, rich venue, fast API)
  const oaMeta = await fetchOpenAlexMetadata(target, email);

  // If OpenAlex returned full high-quality metadata (title, abstract, venue, and date/pages/volume),
  // short-circuit immediately without querying Crossref, saving network latency and avoiding rate limits.
  const hasFullMetadata = Boolean(
    oaMeta &&
    oaMeta.title &&
    oaMeta.abstract &&
    oaMeta.publicationTitle &&
    (oaMeta.pages || oaMeta.volume || oaMeta.date),
  );

  let merged: WorkMetadata | null = null;

  if (hasFullMetadata && oaMeta) {
    merged = oaMeta;
  } else {
    // 2. Query Crossref if OpenAlex is missing or incomplete (e.g. missing abstract or journal)
    const crMeta = await fetchCrossrefMetadata(target, email);

    if (oaMeta && crMeta) {
      // Merge OpenAlex (primary) with Crossref (filling missing fields)
      merged = { ...oaMeta };
      if (!merged.abstract && crMeta.abstract)
        merged.abstract = crMeta.abstract;
      if (!merged.publicationTitle && crMeta.publicationTitle)
        merged.publicationTitle = crMeta.publicationTitle;
      if (!merged.volume && crMeta.volume) merged.volume = crMeta.volume;
      if (!merged.issue && crMeta.issue) merged.issue = crMeta.issue;
      if (!merged.pages && crMeta.pages) merged.pages = crMeta.pages;
      if (!merged.date && crMeta.date) merged.date = crMeta.date;
      if (!merged.title && crMeta.title) merged.title = crMeta.title;
      if (
        (!merged.authors || merged.authors.length === 0) &&
        crMeta.authors &&
        crMeta.authors.length > 0
      ) {
        merged.authors = crMeta.authors;
      }
    } else if (oaMeta) {
      merged = oaMeta;
    } else if (crMeta) {
      merged = crMeta;
    } else {
      // 3. Fallback to DataCite (covers arXiv preprints, Zenodo, etc.)
      merged = await fetchDataCiteMetadata(target);
    }
  }

  if (merged) {
    unifiedMetadataCache.set(target, merged);
  }
  return merged;
}

/**
 * Searches OpenAlex for a paper by title and reconstructs metadata + abstract.
 */
export async function searchOpenAlexForMetadata(
  query: DOIQuery,
  email = "",
): Promise<WorkMetadata | null> {
  if (isOpenAlexSearchThrottled()) {
    return null;
  }
  const cleanTitle = cleanQueryTitle(query.title);
  if (!cleanTitle) return null;

  try {
    const mailto = resolveEmail(email);
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(
      cleanTitle,
    )}&per-page=3${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ""}`;
    const xhr = await requestWithHardTimeout(
      "GET",
      url,
      {
        responseType: "json",
        headers: {
          "User-Agent": API_USER_AGENT,
        },
      },
      10000,
    );

    if (xhr.status === 429) {
      throttleOpenAlexSearch(60000);
      Zotero.debug(
        "[Sci-PDF] OpenAlex metadata search rate limited (429), cooling down for 60s",
      );
      return null;
    }
    if (xhr.status !== 200) return null;
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);
    const results = (data as { results?: unknown[] })?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    for (const item of results) {
      const it = item as {
        doi?: string;
        title?: string;
        display_name?: string;
        publication_year?: number;
        publication_date?: string;
        abstract_inverted_index?: Record<string, number[]>;
        primary_location?: { source?: { display_name?: string } };
        host_venue?: { display_name?: string };
        biblio?: {
          volume?: string;
          issue?: string;
          first_page?: string;
          last_page?: string;
        };
        authorships?: Array<{ author?: { display_name?: string } }>;
      };

      const title = it.title || it.display_name;
      if (!title) continue;

      const sim = titleSimilarity(query.title, title);
      if (sim < 0.85) continue;

      const cleanWorkDoi = it.doi ? cleanDOI(it.doi) : undefined;
      const abstract = reconstructOpenAlexAbstract(it.abstract_inverted_index);
      const publicationTitle =
        it.primary_location?.source?.display_name ||
        it.host_venue?.display_name ||
        null;

      const volume = it.biblio?.volume || null;
      const issue = it.biblio?.issue || null;
      let pages: string | null = null;
      if (it.biblio?.first_page && it.biblio?.last_page) {
        pages =
          it.biblio.first_page === it.biblio.last_page
            ? it.biblio.first_page
            : `${it.biblio.first_page}-${it.biblio.last_page}`;
      } else if (it.biblio?.first_page) {
        pages = it.biblio.first_page;
      }

      const authors = (it.authorships || [])
        .map((a) => a.author?.display_name || "")
        .filter((s) => s.length > 0);

      return {
        doi: cleanWorkDoi,
        title,
        authors,
        year: it.publication_year ?? null,
        date:
          it.publication_date ||
          (it.publication_year ? String(it.publication_year) : null),
        abstract,
        publicationTitle,
        volume,
        issue,
        pages,
        source: "openalex",
      };
    }
  } catch (error) {
    if (String(error).includes("429")) {
      throttleOpenAlexSearch(60000);
      Zotero.debug(
        "[Sci-PDF] OpenAlex metadata search rate limited (429), cooling down for 60s",
      );
    } else {
      Zotero.debug(
        `[Sci-PDF] OpenAlex title search for metadata failed: ${String(error)}`,
      );
    }
  }
  return null;
}

/**
 * Checks whether a field can be written to the given item.
 */
function isFieldAllowed(item: Zotero.Item, field: string): boolean {
  try {
    if (typeof Zotero !== "undefined" && Zotero.ItemFields?.isValidForType) {
      const fieldID = Zotero.ItemFields.getID(field);
      if (!fieldID) return false;
      return Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID);
    }
    if (typeof (item as any).isFieldPermitted === "function") {
      return (item as any).isFieldPermitted(field);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies fetched WorkMetadata to a Zotero item non-destructively:
 * - Only fills empty fields (abstractNote, publicationTitle, date, volume, issue, pages).
 * - Appends audit record to item's extra field.
 * - Adds tag _metadata_enriched.
 */
export async function enrichItemWithMetadata(
  item: Zotero.Item,
  metadata: WorkMetadata,
): Promise<{ updatedFields: string[]; hasAbstract: boolean }> {
  const updatedFields: string[] = [];

  // 1. Abstract
  try {
    if (
      metadata.abstract &&
      isFieldAllowed(item, "abstractNote") &&
      !String(item.getField("abstractNote") || "").trim()
    ) {
      item.setField("abstractNote", metadata.abstract);
      updatedFields.push("abstractNote");
    }
  } catch {
    // ignore
  }

  // 2. Publication / Proceedings / Book Title / Publisher
  if (metadata.publicationTitle) {
    const titleFields = [
      "publicationTitle",
      "proceedingsTitle",
      "bookTitle",
      "institution",
      "repository",
      "publisher",
    ];
    for (const field of titleFields) {
      try {
        if (isFieldAllowed(item, field)) {
          if (!String(item.getField(field) || "").trim()) {
            item.setField(field, metadata.publicationTitle);
            updatedFields.push(field);
          }
          break;
        }
      } catch {
        // try next title field
      }
    }
  }

  // 3. Date
  try {
    if (
      (metadata.date || metadata.year) &&
      isFieldAllowed(item, "date") &&
      !String(item.getField("date") || "").trim()
    ) {
      item.setField("date", metadata.date || String(metadata.year));
      updatedFields.push("date");
    }
  } catch {
    // ignore
  }

  // 4. Volume
  try {
    if (
      metadata.volume &&
      isFieldAllowed(item, "volume") &&
      !String(item.getField("volume") || "").trim()
    ) {
      item.setField("volume", metadata.volume);
      updatedFields.push("volume");
    }
  } catch {
    // ignore
  }

  // 5. Issue
  try {
    if (
      metadata.issue &&
      isFieldAllowed(item, "issue") &&
      !String(item.getField("issue") || "").trim()
    ) {
      item.setField("issue", metadata.issue);
      updatedFields.push("issue");
    }
  } catch {
    // ignore
  }

  // 6. Pages
  try {
    if (
      metadata.pages &&
      isFieldAllowed(item, "pages") &&
      !String(item.getField("pages") || "").trim()
    ) {
      item.setField("pages", metadata.pages);
      updatedFields.push("pages");
    }
  } catch {
    // ignore
  }

  // 7. Extra field audit note & tag
  if (updatedFields.length > 0) {
    const currentExtra = (item.getField("extra") as string) || "";
    const timestamp = new Date().toISOString().slice(0, 10);
    const auditEntry = `[Metadata-Enriched ${timestamp}] Added: ${updatedFields.join(
      ", ",
    )} (source: ${metadata.source || "remote"})`;

    // Key the guard to this specific entry: a blanket "already has an audit
    // line" check would suppress the record of every later enrichment.
    if (!currentExtra.includes(auditEntry)) {
      const nextExtra = currentExtra.trim()
        ? `${currentExtra.trim()}\n${auditEntry}`
        : auditEntry;
      item.setField("extra", nextExtra);
    }

    try {
      item.addTag("_metadata_enriched", 1);
    } catch {
      // ignore tag failure
    }

    await item.saveTx();
  }

  const currentAbstract = String(item.getField("abstractNote") || "").trim();
  return {
    updatedFields,
    hasAbstract: currentAbstract.length > 0,
  };
}

/**
 * End-to-end enrichment pipeline for a single Zotero item:
 * 1. Checks/repairs DOI.
 * 2. Fetches unified metadata from OpenAlex / Crossref.
 * 3. Enriches empty fields in the Zotero item.
 */
export async function enrichSingleItem(
  item: Zotero.Item,
  email = "",
  // The fetch flow verifies/repairs the DOI before downloading. Passing that
  // report in avoids verifying the same item twice (doiRA + Crossref + OpenAlex
  // + DataCite all over again) on the failure path.
  knownDOIReport?: DOIRepairReport,
): Promise<EnrichmentReport> {
  const displayTitle = item.getDisplayTitle();
  if (!item.isRegularItem()) {
    return {
      outcome: "skipped",
      itemTitle: displayTitle,
      updatedFields: [],
      hasAbstract: false,
      message: "Not a regular library item",
    };
  }

  // Step 1: Ensure valid and verified DOI (repairs hallucinated/mismatched/missing DOIs)
  let targetDoi: string | null = null;
  const repairReport =
    knownDOIReport ?? (await verifyAndRepairItemDOI(item, email));
  if (
    repairReport.outcome === "valid" ||
    repairReport.outcome === "repaired" ||
    repairReport.outcome === "completed"
  ) {
    targetDoi = repairReport.newDOI ? cleanDOI(repairReport.newDOI) : null;
  }
  if (!targetDoi) {
    const existingDOIs = await Utils.extractDOIs(item);
    if (existingDOIs.length > 0) {
      targetDoi = cleanDOI(existingDOIs[0]);
    }
  }

  // Step 2: Resolve Metadata
  let metadata: WorkMetadata | null = null;
  if (targetDoi) {
    metadata = await fetchUnifiedMetadata(targetDoi, email);
  }

  // Fallback: If DOI resolution failed or had no DOI, try title-based lookup on OpenAlex
  if (!metadata) {
    const query = buildQuery(item);
    if (query) {
      metadata = await searchOpenAlexForMetadata(query, email);
      if (metadata && metadata.doi && !targetDoi) {
        // Write and save immediately. The fields below are saved only when at
        // least one of them was filled; if the item already had every field
        // populated, this DOI write would otherwise be dropped silently.
        item.setField("DOI", metadata.doi);
        recordDOIAudit(
          item,
          null,
          metadata.doi,
          "Matched during metadata enrichment",
        );
        await item.saveTx();
      }
    }
  }

  if (!metadata) {
    return {
      outcome: "not_found",
      itemTitle: displayTitle,
      doi: targetDoi || undefined,
      updatedFields: [],
      hasAbstract: false,
      message: "No metadata found on OpenAlex/Crossref",
    };
  }

  // Step 3: Enrich item
  const { updatedFields, hasAbstract } = await enrichItemWithMetadata(
    item,
    metadata,
  );

  if (updatedFields.length > 0) {
    return {
      outcome: "enriched",
      itemTitle: displayTitle,
      doi: targetDoi || metadata.doi,
      updatedFields,
      hasAbstract,
      message: `Enriched ${updatedFields.join(", ")}`,
    };
  }

  return {
    outcome: "already_complete",
    itemTitle: displayTitle,
    doi: targetDoi || metadata.doi,
    updatedFields: [],
    hasAbstract,
    message: "All fields already populated",
  };
}
