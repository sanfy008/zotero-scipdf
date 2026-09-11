// Completes a missing DOI for a regular item by matching its title (plus year
// and first author when available) against Crossref. This unlocks both the
// manual Sci-Hub fetch and Zotero's native resolver engine, which can only run
// when the item already carries a DOI.
//
// Matching is deliberately conservative: a wrong DOI would corrupt the user's
// library, so we require a high normalized-title similarity and corroborate
// with year/author whenever those signals exist.

export interface CrossrefCandidate {
  DOI?: string;
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { "date-parts"?: number[][] };
  score?: number;
}

export interface DOIQuery {
  title: string;
  year: number | null;
  authorSurname: string | null;
}

export interface DOIMatch {
  doi: string;
  similarity: number;
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
    .replace(/[^\p{L}\p{N}]+/gu, " ") // support all Unicode letters (Chinese, Latin, Greek, etc.) and numbers
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

function candidateSurnames(candidate: CrossrefCandidate): string[] {
  return (candidate.author ?? [])
    .map((a) => (a.family || a.name || "").toLowerCase().trim())
    .filter((s) => s.length > 0);
}

function candidateYear(candidate: CrossrefCandidate): number | null {
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
    const doi = candidate.DOI?.trim();
    const candidateTitle = candidate.title?.[0];
    if (!doi || !candidateTitle) continue;

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
      best = { doi, similarity };
    }
  }

  return best;
}

function itemYear(item: Zotero.Item): number | null {
  const date = item.getField("date");
  if (!date || typeof date !== "string") return null;
  const match = date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function itemFirstAuthorSurname(item: Zotero.Item): string | null {
  // Single-field creators keep their full name in `lastName`, so it covers both
  // "two-field" and "single-field" creators.
  for (const creator of item.getCreators()) {
    if (creator.lastName) return creator.lastName;
  }
  return null;
}

function buildQuery(item: Zotero.Item): DOIQuery | null {
  const title = item.getField("title");
  if (!title || typeof title !== "string" || !title.trim()) return null;
  return {
    title: title.trim(),
    year: itemYear(item),
    authorSurname: itemFirstAuthorSurname(item),
  };
}

function cleanQueryTitle(title: string): string {
  return title
    .replace(/<[^>]*>/g, " ")
    .replace(/^["'“‘\s]+|["'”’\s]+$/g, "")
    .replace(/[.,;:?]+$/, "")
    .trim();
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
// registration-agency endpoint. This is authoritative and registrar-agnostic,
// unlike Crossref (which 404s on perfectly valid DataCite DOIs). Returns:
//   true  — the DOI is registered somewhere
//   false — the DOI does not exist anywhere (safe to attempt a correction)
//   null  — undetermined (network/parse error); the caller must NOT act on this
export async function doiExists(doi: string): Promise<boolean | null> {
  const target = doi.trim();
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
          "User-Agent": "zotero-scipdf (https://github.com/syt2/zotero-scipdf)",
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
    // A registered DOI reports its agency, e.g. { RA: "Crossref" }. A missing
    // one reports { status: "DOI does not exist" } (or "Invalid DOI").
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

// Looks up a DOI for an item that has none. Returns null on any failure so the
// caller can fall back to the existing "DOI missing" behavior.
export async function findDOI(
  item: Zotero.Item,
  email = "",
): Promise<DOIMatch | null> {
  const query = buildQuery(item);
  if (!query) return null;

  try {
    const xhr = await Zotero.HTTP.request(
      "GET",
      buildCrossrefURL(query, email),
      {
        responseType: "json",
        timeout: 20000,
        headers: {
          "User-Agent": "zotero-scipdf (https://github.com/syt2/zotero-scipdf)",
        },
      },
    );
    const candidates = (xhr.response as { message?: { items?: unknown } })
      ?.message?.items;
    if (!Array.isArray(candidates)) return null;
    return selectBestDOI(query, candidates as CrossrefCandidate[]);
  } catch (error) {
    Zotero.debug(`[Sci-PDF] DOI completion request failed: ${String(error)}`);
    return null;
  }
}
