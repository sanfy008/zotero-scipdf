// Consume the complete DOI token; letters are part of the suffix, not delimiters.
export const doiRegexps: RegExp[] = [
  /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)(?=$|[\s"<>?#])/gi,
];

export function cleanDOI(doi: string): string {
  if (!doi) return "";
  // Strip URL prefixes, doi: schemes, and trailing punctuation
  return doi
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "")
    .replace(/[.,;:()[\]]+$/, "")
    .trim();
}

export function matchDOIs(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const regexp of doiRegexps) {
    regexp.lastIndex = 0;
    let match;
    while ((match = regexp.exec(text)) !== null) {
      const doi = cleanDOI(match[1]);
      if (doi && !seen.has(doi.toLowerCase())) {
        seen.add(doi.toLowerCase());
        results.push(doi);
      }
    }
  }
  return results;
}

// Explicit arXiv identifier patterns: URL, DataCite DOI, or prefixed with arXiv:
const explicitArxivRegexps: RegExp[] = [
  /(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/gi,
  /\b10\.48550\/arXiv\.([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)\b/gi,
  /\barXiv:\s*([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)\b/gi,
];

// Standalone arXiv ID: modern 4.4-5 digits or legacy archive/7 digits
const standaloneArxivRegex =
  /^([a-z-]+(?:\.[a-z-]+)?\/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)$/i;

export function matchArXivIDs(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const clean = raw
      .replace(/\.pdf$/i, "")
      .replace(/[.,;:()[\]]+$/, "")
      .trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      results.push(clean);
    }
  };

  for (const reg of explicitArxivRegexps) {
    reg.lastIndex = 0;
    let match;
    while ((match = reg.exec(text)) !== null) {
      if (match[1]) add(match[1]);
    }
  }

  const trimmed = text.trim();
  const standaloneMatch = standaloneArxivRegex.exec(trimmed);
  if (standaloneMatch && standaloneMatch[1]) {
    add(standaloneMatch[1]);
  }

  return results;
}
