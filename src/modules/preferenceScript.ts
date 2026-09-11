import { config } from "../../package.json";
import { sciHubCustomResolver, openAlexCustomResolver } from "./CustomResolver";
import type { CustomResolver } from "./CustomResolver";
import { CustomResolverManager } from "./CustomResolverManager";
import { getPref, setPref } from "../utils/prefs";

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }

  const doc = _window.document;
  const byId = <T extends Element>(suffix: string) =>
    doc.querySelector(`#zotero-prefpane-${config.addonRef}-${suffix}`) as T;

  const autoDownloadCheckbox = byId<XUL.Checkbox>("autoDownload");
  const openAlexCheckbox = byId<XUL.Checkbox>("openAlex");
  const unpaywallCheckbox = byId<XUL.Checkbox>("unpaywall");
  const semanticScholarCheckbox = byId<XUL.Checkbox>("semanticScholar");
  const arxivCheckbox = byId<XUL.Checkbox>("arxiv");
  const completeDOICheckbox = byId<XUL.Checkbox>("completeDOI");
  const scihubEnabledCheckbox = byId<XUL.Checkbox>("scihubEnabled");
  const emailInput = byId<HTMLInputElement>("email");
  const urlInput = byId<HTMLInputElement>("scihubUrl");

  const current = CustomResolverManager.shared.customResolvers;
  const sciHubResolvers = current.filter((r) => r.name === "Sci-Hub");

  autoDownloadCheckbox.checked =
    current.length > 0 && current.every((r) => r.automatic !== false);
  openAlexCheckbox.checked = current.some((r) => r.name === "OpenAlex");
  // The manual "Fetch PDF" action reads these prefs; keep the OpenAlex pref in
  // sync with the resolver-derived checkbox state. OA sources default on.
  setPref("openAlex", openAlexCheckbox.checked);
  unpaywallCheckbox.checked = getPref("unpaywall") !== false;
  semanticScholarCheckbox.checked = getPref("semanticScholar") !== false;
  arxivCheckbox.checked = getPref("arxiv") !== false;
  // Sci-Hub fallback is opt-in: off unless the user turned it on.
  scihubEnabledCheckbox.checked = getPref("scihubEnabled") === true;
  // Missing-DOI completion is opt-out: enabled unless the user turned it off.
  completeDOICheckbox.checked = getPref("completeDOI") !== false;
  emailInput.value = getPref("email") || "";
  urlInput.value = sciHubResolvers.map((e) => e.url).join(",");

  const rebuildResolvers = () => {
    const automatic = autoDownloadCheckbox.checked;
    const email = emailInput.value.trim();
    setPref("email", email);
    setPref("openAlex", openAlexCheckbox.checked);

    const next: CustomResolver[] = [];
    // OpenAlex (legal OA) is tried before Sci-Hub.
    if (openAlexCheckbox.checked) {
      next.push(openAlexCustomResolver(email, automatic));
    }

    const seen = new Set<string>();
    const normalizedURLs: string[] = [];
    for (const raw of urlInput.value.split(/\s*[;,，；、\s]\s*/)) {
      const url = raw.trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      const resolver = sciHubCustomResolver(url, automatic);
      next.push(resolver);
      normalizedURLs.push(resolver.url);
    }
    urlInput.value = normalizedURLs.join(",");

    CustomResolverManager.shared.removeAllCustomResolversInZotero();
    if (next.length > 0) {
      CustomResolverManager.shared.appendCustomResolversInZotero(next);
    }
  };

  autoDownloadCheckbox.addEventListener("command", rebuildResolvers);
  openAlexCheckbox.addEventListener("command", rebuildResolvers);
  unpaywallCheckbox.addEventListener("command", () => {
    setPref("unpaywall", unpaywallCheckbox.checked);
  });
  semanticScholarCheckbox.addEventListener("command", () => {
    setPref("semanticScholar", semanticScholarCheckbox.checked);
  });
  arxivCheckbox.addEventListener("command", () => {
    setPref("arxiv", arxivCheckbox.checked);
  });
  scihubEnabledCheckbox.addEventListener("command", () => {
    setPref("scihubEnabled", scihubEnabledCheckbox.checked);
  });
  completeDOICheckbox.addEventListener("command", () => {
    setPref("completeDOI", completeDOICheckbox.checked);
  });
  emailInput.addEventListener("change", rebuildResolvers);
  urlInput.addEventListener("change", rebuildResolvers);
}
