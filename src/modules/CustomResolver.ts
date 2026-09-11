// https://www.zotero.org/support/kb/custom_pdf_resolvers
// https://github.com/zotero/zotero/blob/5536f8d2bd08ddac9074b9df05b7d205273835e7/chrome/content/zotero/xpcom/attachments.js#L1350
export interface CustomResolver {
  name: string;
  method: "GET" | "POST";
  url: string; // must include {doi}
  mode: "html" | "json";
  selector: string;
  automatic?: boolean;

  // HTML
  attribute?: string;
  index?: number;

  // JSON
  mappings?: {
    url?: string;
    pageURL?: string;
  };
}

export function isCustomResolverEqual(a: CustomResolver, b: CustomResolver) {
  return (
    a.name === b.name &&
    a.method === b.method &&
    a.url === b.url &&
    a.mode === b.mode &&
    a.selector === b.selector &&
    a.automatic === b.automatic &&
    a.attribute === b.attribute &&
    a.index === b.index &&
    a.mappings?.url === b.mappings?.url &&
    a.mappings?.pageURL === b.mappings?.pageURL
  );
}

export function sciHubCustomResolver(
  url: string,
  automatic = true,
): CustomResolver {
  return {
    name: "Sci-Hub",
    method: "GET",
    url: url.includes("{doi}")
      ? url
      : url.endsWith("/")
        ? `${url}{doi}`
        : `${url}/{doi}`,
    mode: "html",
    selector: "#pdf",
    attribute: "src",
    automatic: automatic,
  };
}

export function presetSciHubCustomResolvers(
  automatic = true,
): Readonly<Readonly<CustomResolver>[]> {
  // Only the mirrors that are reliably reachable. Dead mirrors just add a
  // per-item timeout wait, so we keep this list short on purpose.
  const scihubURLs = [
    "https://sci-hub.se/",
    "https://sci-hub.st/",
    "https://sci-hub.ru/",
  ];
  return scihubURLs.map((url) => {
    return {
      name: "Sci-Hub",
      method: "GET",
      url: `${url}{doi}`,
      mode: "html",
      selector: "#pdf",
      attribute: "src",
      automatic: automatic,
    };
  });
}

// Legal open-access resolver backed by the OpenAlex API. OpenAlex aggregates
// OA copies from publishers and repositories, so it frequently finds full text
// (including recent papers) that Sci-Hub does not have. When a location has no
// direct `pdf_url`, we still surface its `landing_page_url` as `pageURL` so
// Zotero can run its translators on the landing page to reach the PDF.
// See https://www.zotero.org/support/kb/custom_pdf_resolvers (JSON/JSPath mode).
export function openAlexCustomResolver(
  email = "",
  automatic = true,
): CustomResolver {
  const mailto = email.trim()
    ? `?mailto=${encodeURIComponent(email.trim())}`
    : "";
  return {
    name: "OpenAlex",
    method: "GET",
    url: `https://api.openalex.org/works/doi:{doi}${mailto}`,
    mode: "json",
    selector: ".locations",
    mappings: {
      url: "pdf_url",
      pageURL: "landing_page_url",
    },
    automatic: automatic,
  };
}
