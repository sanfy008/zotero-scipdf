// Sent as the User-Agent for every third-party API call (Crossref, OpenAlex,
// DataCite, doi.org). These services use it for polite-pool routing and abuse
// contact; keep it in one place so a repo move can't leave stale copies behind.
export const API_USER_AGENT =
  "zotero-scipdf (https://github.com/syt2/zotero-scipdf)";
