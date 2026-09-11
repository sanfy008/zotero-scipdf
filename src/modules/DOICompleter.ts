import { cleanDOI } from "../utils/identifierPatterns";
import { Utils } from "../utils/utils";

export interface CrossrefCandidate {
  DOI?: string;
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { "date-parts"?: number[][] };
  score?: number;
  source?: "crossref" | "openalex" | "datacite";
}

export interface DOIQuery {
  title: string;
  year: number | null;
  authorSurname: string | null;
}

export interface DOIMatch {
  doi: string;
  similarity: number;
  source?: string;
}

export type DOIVerificationStatus =
  | "valid"       // DOI exists globally and title matches item title
  | "not_found"   // DOI does not exist anywhere globally (doiRA 404 / Invalid)
  | "mismatched"  // DOI exists globally, but title clearly does NOT match (hallucinated / swapped)
  | "unverified"; // Network / lookup failure, keep current to prevent false edits

export interface DOIVerificationResult {
  status: DOIVerificationStatus;
  doi: string;
  registeredTitle?: string;
  similarity?: number;
  registeredYear?: number | null;
  registeredAuthors?: string[];
  message?: string;
}

export interface DOIRepairReport {
  outcome: "valid" | "repaired" | "completed" | "unresolved" | "skipped";
  oldDOI?: string;
  newDOI?: string;
  detail?: "not_found" | "mismatched" | "missing" | "arxiv" | string;
  similarity?: number;
  message?: string;
}

// A candidate needs at least this normalized-title similarity to be considered.
export const TITLE_SIMILARITY_THRESHOLD = 0.9;
// When neither year nor author can corroborate the match, demand a near-exact
// title instead, to keep false positives from slipping through on title alone.
export const STRICT_TITLE_SIMILARITY_THRESHOLD = 0.97;
// Published years drift by a year between "online" and "issue" dates.
const YEAR_TOLERANCE = 1;

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/<[^>]*>/g, " ") // Crossref titles may embed markup
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ") // support all Unicode letters and numbers
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    previous[j] = j;
  }
  for (let i = 0; i < a.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1, // insertion
        previous[j + 1] + 1, // deletion
        previous[j] + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

// Normalized similarity in [0, 1]: 1 means the titles are identical after
// normalization, 0 means completely different.
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - levenshtein(na, nb) / maxLen;
}

export function candidateSurnames(candidate: CrossrefCandidate): string[] {
  return (candidate.author ?? [])
    .map((a) => (a.family || a.name || "").toLowerCase().trim())
    .filter((s) => s.length > 0);
}

export function candidateYear(candidate: CrossrefCandidate): number | null {
  const year = candidate.issued?.["date-parts"]?.[0]?.[0];
  return typeof year === "number" ? year : null;
}

export function formatArXivDOI(arxivId: string): string {
  const clean = arxivId
    .replace(/v\d+$/i, "")
    .replace(/[.,;:()[\]]+$/, "")
    .trim();
  return `10.48550/arXiv.${clean}`;
}

// Picks the best-matching candidate that clears every applicable guard, or null
// when none is trustworthy enough to write back.
export function selectBestDOI(
  query: DOIQuery,
  candidates: CrossrefCandidate[],
): DOIMatch | null {
  const wantedSurname = query.authorSurname?.toLowerCase().trim() || null;
  let best: DOIMatch | null = null;

  for (const candidate of candidates) {
    const rawDoi = candidate.DOI?.trim();
    const candidateTitle = candidate.title?.[0];
    if (!rawDoi || !candidateTitle) continue;
    const doi = cleanDOI(rawDoi);

    let similarity = titleSimilarity(query.title, candidateTitle);

    const candYear = candidateYear(candidate);
    const yearKnown = query.year != null && candYear != null;
    const sameYear =
      yearKnown &&
      Math.abs((query.year as number) - (candYear as number)) <= YEAR_TOLERANCE;

    const surnames = candidateSurnames(candidate);
    const authorKnown = wantedSurname != null && surnames.length > 0;
    const authorMatches =
      authorKnown &&
      surnames.some(
        (s) => s.includes(wantedSurname) || wantedSurname.includes(s),
      );

    // If full title similarity is below threshold (e.g. subtitle omitted),
    // check if the primary title matches with high similarity when year and author strictly match.
    if (
      similarity < TITLE_SIMILARITY_THRESHOLD &&
      sameYear &&
      authorMatches
    ) {
      const queryMain = query.title.split(/[:\-–—?]/)[0].trim();
      const candMain = candidateTitle.split(/[:\-–—?]/)[0].trim();
      if (queryMain.length >= 10 && candMain.length >= 10) {
        const mainSim = titleSimilarity(queryMain, candMain);
        if (mainSim >= 0.95) {
          similarity = Math.max(similarity, TITLE_SIMILARITY_THRESHOLD);
        }
      }
    }

    if (similarity < TITLE_SIMILARITY_THRESHOLD) continue;

    if (
      yearKnown &&
      Math.abs((query.year as number) - (candYear as number)) > YEAR_TOLERANCE
    ) {
      continue;
    }

    if (authorKnown && !authorMatches) {
      continue;
    }

    // Title alone is a weak signal; require a near-exact match when we cannot
    // corroborate with either year or author.
    if (
      !yearKnown &&
      !authorKnown &&
      similarity < STRICT_TITLE_SIMILARITY_THRESHOLD
    ) {
      continue;
    }

    if (!best || similarity > best.similarity) {
      best = { doi, similarity, source: candidate.source };
    }
  }

  return best;
}

export function itemYear(item: Zotero.Item): number | null {
  const date = item.getField("date");
  if (!date || typeof date !== "string") return null;
  const match = date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

export function itemFirstAuthorSurname(item: Zotero.Item): string | null {
  for (const creator of item.getCreators()) {
    if (creator.lastName) return creator.lastName;
  }
  return null;
}

export function buildQuery(item: Zotero.Item): DOIQuery | null {
  const title = item.getField("title");
  if (!title || typeof title !== "string" || !title.trim()) return null;
  return {
    title: title.trim(),
    year: itemYear(item),
    authorSurname: itemFirstAuthorSurname(item),
  };
}

export function cleanQueryTitle(title: string): string {
  return title
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildCrossrefURL(query: DOIQuery, email: string): string {
  const params = new URLSearchParams();
  params.set("query.bibliographic", cleanQueryTitle(query.title));
  if (query.authorSurname) {
    params.set("query.author", query.authorSurname);
  }
  params.set("rows", "5");
  params.set("select", "DOI,title,author,issued,score");
  const mailto = email.trim();
  if (mailto) {
    params.set("mailto", mailto);
  }
  return `https://api.crossref.org/works?${params.toString()}`;
}

// Checks whether a DOI actually exists in the global DOI system, via the DOI
// registration-agency endpoint.
export async function doiExists(doi: string): Promise<boolean | null> {
  const target = cleanDOI(doi);
  if (!target) return null;
  try {
    const xhr = await Zotero.HTTP.request(
      "GET",
      `https://doi.org/doiRA/${encodeURI(target)}`,
      {
        responseType: "json",
        timeout: 15000,
        successCodes: false,
        headers: {
          "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
        },
      },
    );
    if (xhr.status !== 200) return null;
    let data = xhr.response;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return null;
      }
    }
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.RA === "string" && record.RA.trim()) return true;
    const status =
      typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (status.includes("does not exist") || status.includes("invalid")) {
      return false;
    }
    return null;
  } catch (error) {
    Zotero.debug(`[Sci-PDF] DOI existence check failed: ${String(error)}`);
    return null;
  }
}

// Fetches authoritative metadata (registered title, authors, year) for a specific DOI.
export async function fetchDOIMetadata(
  doi: string,
  email = "",
): Promise<{ title?: string; year?: number | null; authors?: string[] } | null> {
  const target = cleanDOI(doi);
  if (!target) return null;

  // 1. Crossref works lookup
  try {
    const mailto = email.trim();
    const crUrl = `https://api.crossref.org/works/${encodeURIComponent(target)}${mailto ? `?mailto=${encodeURIComponent(mailto)}` : ""}`;
    const xhr = await Zotero.HTTP.request("GET", crUrl, {
      responseType: "json",
      timeout: 12000,
      headers: {
        "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
      },
    });
    if (xhr.status === 200) {
      let data = xhr.response;
      if (typeof data === "string") data = JSON.parse(data);
      const msg = (data as { message?: Record<string, unknown> })?.message;
      if (msg) {
        const titleArr = msg.title as string[] | undefined;
        const title = titleArr?.[0];
        const year = (msg.issued as { "date-parts"?: number[][] })?.["date-parts"]?.[0]?.[0] ?? null;
        const authors = ((msg.author as Array<{ family?: string; name?: string }>) || [])
          .map((a) => a.family || a.name || "")
          .filter((s) => s.length > 0);
        if (title) {
          return { title, year, authors };
        }
      }
    }
  } catch {
    // fall through to OpenAlex
  }

  // 2. OpenAlex works lookup
  try {
    const mailto = email.trim();
    const oaUrl = `https://api.openalex.org/works/doi:${encodeURIComponent(target)}${mailto ? `?mailto=${encodeURIComponent(mailto)}` : ""}`;
    const xhr = await Zotero.HTTP.request("GET", oaUrl, {
      responseType: "json",
      timeout: 12000,
      headers: {
        "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
      },
    });
    if (xhr.status === 200) {
      let data = xhr.response;
      if (typeof data === "string") data = JSON.parse(data);
      const record = data as {
        title?: string;
        display_name?: string;
        publication_year?: number;
        authorships?: Array<{ author?: { display_name?: string } }>;
      };
      const title = record?.title || record?.display_name;
      const year = typeof record?.publication_year === "number" ? record.publication_year : null;
      const authors = (record?.authorships || [])
        .map((a) => {
          const name = a.author?.display_name || "";
          const parts = name.trim().split(/\s+/);
          return parts[parts.length - 1] || "";
        })
        .filter((s) => s.length > 0);
      if (title) {
        return { title, year, authors };
      }
    }
  } catch {
    // fall through to DataCite
  }

  // 3. DataCite lookup (covers arXiv preprints, Zenodo, etc.)
  try {
    const dcUrl = `https://api.datacite.org/dois/${encodeURIComponent(target)}`;
    const xhr = await Zotero.HTTP.request("GET", dcUrl, {
      responseType: "json",
      timeout: 12000,
      headers: {
        "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
      },
    });
    if (xhr.status === 200) {
      let data = xhr.response;
      if (typeof data === "string") data = JSON.parse(data);
      const attr = (data as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes;
      if (attr) {
        const titles = attr.titles as Array<{ title?: string }> | undefined;
        const title = titles?.[0]?.title;
        const year = typeof attr.publicationYear === "number" ? attr.publicationYear : null;
        const authors = ((attr.creators as Array<{ name?: string }>) || [])
          .map((c) => c.name || "")
          .filter((s) => s.length > 0);
        if (title) {
          return { title, year, authors };
        }
      }
    }
  } catch {
    // all failed
  }

  return null;
}

// Performs a bidirectional consistency check:
// 1. Checks global existence via doiRA.
// 2. Fetches registered metadata to confirm the DOI actually belongs to this paper.
export async function verifyDOI(
  doi: string,
  expectedTitle: string,
  expectedYear?: number | null,
  expectedAuthorSurname?: string | null,
  email = "",
): Promise<DOIVerificationResult> {
  const clean = cleanDOI(doi);
  if (!clean) {
    return { status: "not_found", doi: clean, message: "DOI is empty" };
  }

  const exists = await doiExists(clean);
  if (exists === false) {
    return {
      status: "not_found",
      doi: clean,
      message: "DOI does not exist in global registry (404/invalid)",
    };
  }
  if (exists === null) {
    return {
      status: "unverified",
      doi: clean,
      message: "Global registry check timed out or failed",
    };
  }

  // DOI exists globally. Now verify title consistency:
  const metadata = await fetchDOIMetadata(clean, email);
  if (!metadata || !metadata.title) {
    // If metadata cannot be reached, stay conservative and do not overwrite
    return {
      status: "unverified",
      doi: clean,
      message: "DOI exists globally, but metadata could not be fetched",
    };
  }

  const regTitle = metadata.title;
  const sim = titleSimilarity(expectedTitle, regTitle);

  // Subtitle tolerance check
  const expMain = expectedTitle.split(/[:\-–—?]/)[0].trim();
  const regMain = regTitle.split(/[:\-–—?]/)[0].trim();
  const mainSim =
    expMain.length >= 10 && regMain.length >= 10
      ? titleSimilarity(expMain, regMain)
      : sim;
  const effectiveSim = Math.max(sim, mainSim >= 0.90 ? 0.90 : 0);

  // Match check
  if (effectiveSim >= 0.75) {
    return {
      status: "valid",
      doi: clean,
      registeredTitle: regTitle,
      similarity: effectiveSim,
      registeredYear: metadata.year,
      registeredAuthors: metadata.authors,
    };
  }

  // If similarity is very low and main clause also fails, it's definitely mismatched!
  if (effectiveSim < 0.60 && mainSim < 0.70) {
    return {
      status: "mismatched",
      doi: clean,
      registeredTitle: regTitle,
      similarity: effectiveSim,
      registeredYear: metadata.year,
      registeredAuthors: metadata.authors,
      message: `DOI belongs to another paper: "${regTitle}"`,
    };
  }

  // Borderline similarity: check year and author
  const wantedSurname = expectedAuthorSurname?.toLowerCase().trim() || null;
  const candYear = metadata.year;
  const yearMatch =
    expectedYear != null && candYear != null
      ? Math.abs(expectedYear - candYear) <= YEAR_TOLERANCE
      : true;
  const authorMatch =
    wantedSurname && metadata.authors && metadata.authors.length > 0
      ? metadata.authors.some(
          (a) =>
            a.toLowerCase().includes(wantedSurname) ||
            wantedSurname.includes(a.toLowerCase()),
        )
      : true;

  if (yearMatch && authorMatch && effectiveSim >= 0.65) {
    return {
      status: "valid",
      doi: clean,
      registeredTitle: regTitle,
      similarity: effectiveSim,
      registeredYear: metadata.year,
      registeredAuthors: metadata.authors,
    };
  }

  return {
    status: "mismatched",
    doi: clean,
    registeredTitle: regTitle,
    similarity: effectiveSim,
    registeredYear: metadata.year,
    registeredAuthors: metadata.authors,
    message: `DOI belongs to another paper: "${regTitle}"`,
  };
}

// Search OpenAlex works API for candidate DOIs by title
export async function searchOpenAlexForDOI(
  query: DOIQuery,
  email = "",
): Promise<CrossrefCandidate[]> {
  const cleanTitle = cleanQueryTitle(query.title);
  if (!cleanTitle) return [];

  try {
    const mailto = email.trim();
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(cleanTitle)}&per-page=5${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ""}`;
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 15000,
      headers: {
        "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
      },
    });
    if (xhr.status !== 200) return [];
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);
    const results = (data as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) return [];

    const candidates: CrossrefCandidate[] = [];
    for (const item of results) {
      const it = item as {
        doi?: string;
        title?: string;
        display_name?: string;
        publication_year?: number;
        authorships?: Array<{ author?: { display_name?: string } }>;
      };
      const rawDoi = it.doi;
      if (!rawDoi) continue;
      const doi = cleanDOI(rawDoi);
      const title = it.title || it.display_name;
      if (!doi || !title) continue;

      const authors = (it.authorships || []).map((a) => {
        const name = a.author?.display_name || "";
        const parts = name.trim().split(/\s+/);
        return { family: parts[parts.length - 1], name };
      });

      candidates.push({
        DOI: doi,
        title: [title],
        author: authors,
        issued: typeof it.publication_year === "number" ? { "date-parts": [[it.publication_year]] } : undefined,
        source: "openalex",
      });
    }
    return candidates;
  } catch (error) {
    Zotero.debug(`[Sci-PDF] OpenAlex DOI search failed: ${String(error)}`);
    return [];
  }
}

// Search Crossref works API for candidate DOIs
export async function searchCrossrefForDOI(
  query: DOIQuery,
  email = "",
): Promise<CrossrefCandidate[]> {
  try {
    const xhr = await Zotero.HTTP.request(
      "GET",
      buildCrossrefURL(query, email),
      {
        responseType: "json",
        timeout: 20000,
        headers: {
          "User-Agent": "zotero-scipdf (https://github.com/sanfy008/zotero-scipdf)",
        },
      },
    );
    if (xhr.status !== 200) return [];
    let data = xhr.response;
    if (typeof data === "string") data = JSON.parse(data);
    const items = (data as { message?: { items?: unknown[] } })?.message?.items;
    if (!Array.isArray(items)) return [];

    return items.map((cand) => ({
      ...(cand as CrossrefCandidate),
      source: "crossref",
    }));
  } catch (error) {
    Zotero.debug(`[Sci-PDF] Crossref DOI search failed: ${String(error)}`);
    return [];
  }
}

// Multi-source search across OpenAlex + Crossref with deduplication
export async function findDOIMultiSource(
  query: DOIQuery,
  email = "",
): Promise<DOIMatch | null> {
  const [oaCandidates, crCandidates] = await Promise.all([
    searchOpenAlexForDOI(query, email),
    searchCrossrefForDOI(query, email),
  ]);

  const pool: CrossrefCandidate[] = [];
  const seenDOIs = new Set<string>();

  for (const c of [...oaCandidates, ...crCandidates]) {
    if (!c.DOI) continue;
    const clean = cleanDOI(c.DOI).toLowerCase();
    if (!seenDOIs.has(clean)) {
      seenDOIs.add(clean);
      pool.push(c);
    }
  }

  if (pool.length === 0) return null;
  return selectBestDOI(query, pool);
}

// Backward-compatible findDOI delegation
export async function findDOI(
  item: Zotero.Item,
  email = "",
): Promise<DOIMatch | null> {
  const query = buildQuery(item);
  if (!query) return null;
  return findDOIMultiSource(query, email);
}

// Appends an audit trail entry in the Zotero item's `extra` field and sets tags.
export function recordDOIAudit(
  item: Zotero.Item,
  oldDOI: string | null,
  newDOI: string,
  reason: string,
): void {
  const currentExtra = (item.getField("extra") as string) || "";
  const timestamp = new Date().toISOString().slice(0, 10);
  const auditEntry = oldDOI
    ? `[DOI-Audit ${timestamp}] Replaced ${oldDOI} -> ${newDOI} (${reason})`
    : `[DOI-Audit ${timestamp}] Added DOI -> ${newDOI} (${reason})`;

  if (!currentExtra.includes(newDOI)) {
    const updatedExtra = currentExtra.trim()
      ? `${currentExtra.trim()}\n${auditEntry}`
      : auditEntry;
    item.setField("extra", updatedExtra);
  }

  try {
    item.addTag("_doi_repaired", 1);
  } catch {
    // ignore tag failures
  }
}

// Complete verification and repair pipeline for a single Zotero item.
export async function verifyAndRepairItemDOI(
  item: Zotero.Item,
  email = "",
): Promise<DOIRepairReport> {
  const title = item.getField("title");
  if (!title || typeof title !== "string" || !title.trim()) {
    return { outcome: "skipped", message: "Item has no title" };
  }

  const query: DOIQuery = {
    title: title.trim(),
    year: itemYear(item),
    authorSurname: itemFirstAuthorSurname(item),
  };

  const arxivIds = await Utils.extractArXivIDs(item);
  const existingDOIs = await Utils.extractDOIs(item);

  // 1. If item has NO DOI at all:
  if (existingDOIs.length === 0) {
    if (arxivIds.length > 0) {
      const arxivDOI = formatArXivDOI(arxivIds[0]);
      item.setField("DOI", arxivDOI);
      recordDOIAudit(item, null, arxivDOI, "Synthesized from arXiv ID");
      await item.saveTx();
      return {
        outcome: "completed",
        newDOI: arxivDOI,
        detail: "arxiv",
        message: `Set arXiv DOI: ${arxivDOI}`,
      };
    }

    const match = await findDOIMultiSource(query, email);
    if (!match) {
      return { outcome: "unresolved", detail: "missing", message: "No matching DOI found" };
    }
    item.setField("DOI", match.doi);
    recordDOIAudit(item, null, match.doi, `Found via ${match.source || "multi-source"}`);
    await item.saveTx();
    return {
      outcome: "completed",
      newDOI: match.doi,
      detail: "missing",
      similarity: match.similarity,
      message: `Completed DOI: ${match.doi}`,
    };
  }

  // 2. Item HAS an existing DOI: perform bidirectional verification
  const currentDOI = cleanDOI(existingDOIs[0]);
  const verification = await verifyDOI(
    currentDOI,
    query.title,
    query.year,
    query.authorSurname,
    email,
  );

  if (verification.status === "valid") {
    try {
      item.addTag("_doi_verified", 1);
      await item.saveTx();
    } catch {
      // ignore
    }
    return {
      outcome: "valid",
      oldDOI: currentDOI,
      newDOI: currentDOI,
      similarity: verification.similarity,
      message: "DOI verified and matches paper",
    };
  }

  if (verification.status === "unverified") {
    return {
      outcome: "unresolved",
      oldDOI: currentDOI,
      message: verification.message || "Lookup inconclusive",
    };
  }

  // 3. DOI is either "not_found" (404/invalid) or "mismatched" (hallucinated / swapped)
  const mismatchReason =
    verification.status === "not_found"
      ? "DOI does not exist (404)"
      : `Mismatched with "${verification.registeredTitle || ""}"`;

  // If item has an arXiv ID, prioritize standard DataCite DOI:
  if (arxivIds.length > 0) {
    const arxivDOI = formatArXivDOI(arxivIds[0]);
    item.setField("DOI", arxivDOI);
    recordDOIAudit(item, currentDOI, arxivDOI, mismatchReason);
    await item.saveTx();
    return {
      outcome: "repaired",
      oldDOI: currentDOI,
      newDOI: arxivDOI,
      detail: "arxiv",
      message: `Replaced with arXiv DOI: ${arxivDOI}`,
    };
  }

  // Search for the true DOI via multi-source:
  const match = await findDOIMultiSource(query, email);
  if (!match || match.doi.toLowerCase() === currentDOI.toLowerCase()) {
    try {
      item.addTag("_doi_invalid", 1);
      await item.saveTx();
    } catch {
      // ignore
    }
    return {
      outcome: "unresolved",
      oldDOI: currentDOI,
      detail: verification.status,
      message: `DOI is ${verification.status}, but no matching replacement found`,
    };
  }

  // True replacement found!
  item.setField("DOI", match.doi);
  recordDOIAudit(item, currentDOI, match.doi, mismatchReason);
  try {
    item.removeTag("_doi_invalid");
  } catch {
    // ignore
  }
  await item.saveTx();

  return {
    outcome: "repaired",
    oldDOI: currentDOI,
    newDOI: match.doi,
    detail: verification.status,
    similarity: match.similarity,
    message: `Replaced ${currentDOI} -> ${match.doi}`,
  };
}
