import { LargePrefHelper } from "zotero-plugin-toolkit";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import {
  CustomResolver,
  isCustomResolverEqual,
  isSciHubResolver,
} from "./CustomResolver";

export class CustomResolverManager {
  private static _shared?: CustomResolverManager;
  private static zoteroCustomResolversPrefKey: Readonly<string> =
    "extensions.zotero.findPDFs.resolvers";
  private static customResolversPrefKey: Readonly<string> = "resolvers";
  private static customResolversLargerPrefKey: Readonly<string> =
    "userCustomResolvers";
  static get shared() {
    if (!this._shared) {
      this._shared = new CustomResolverManager();
    }
    return this._shared;
  }

  // user custom resolvers
  private prefs = new LargePrefHelper(
    CustomResolverManager.customResolversLargerPrefKey,
    config.prefsPrefix,
    "parser",
  );
  get customResolvers() {
    return (
      (this.prefs.getValue(
        CustomResolverManager.customResolversPrefKey,
      ) as CustomResolver[]) ?? []
    );
  }
  private set customResolvers(value: CustomResolver[]) {
    this.prefs.setValue(CustomResolverManager.customResolversPrefKey, value);
  }

  // Keep configured mirrors separately from active Zotero resolvers: disabled
  // sources remain editable, but cannot participate in manual or automatic PDF
  // resolution. Only replace this plugin's entries; preserve other resolvers.
  replaceCustomResolversInZotero(
    resolvers: CustomResolver[] | Readonly<CustomResolver[]>,
  ) {
    const previous = this.customResolvers;
    const configured: CustomResolver[] = [];
    for (const resolver of resolvers) {
      if (!configured.some((entry) => isCustomResolverEqual(entry, resolver))) {
        configured.push(resolver);
      }
    }
    const owned = [...previous, ...configured];
    const sciHubEnabled = getPref("scihubEnabled") === true;
    const preserved = this.customResolversInZotero.filter((entry) => {
      if (owned.some((resolver) => isCustomResolverEqual(entry, resolver))) {
        return false;
      }
      // Disabling Sci-Hub must also silence legacy/renamed Sci-Hub entries
      // this plugin did not configure. Otherwise Zotero's manual "Find
      // Available PDF" can still reach a sci-hub.* host.
      if (!sciHubEnabled && isSciHubResolver(entry)) {
        return false;
      }
      return true;
    });
    const active = configured.filter(
      (resolver) => resolver.name !== "Sci-Hub" || sciHubEnabled,
    );
    this.customResolversInZotero = [...preserved, ...active];
    this.customResolvers = configured;
  }

  appendCustomResolversInZotero(
    resolvers: CustomResolver[] | Readonly<CustomResolver[]>,
  ) {
    this.replaceCustomResolversInZotero([
      ...this.customResolvers,
      ...resolvers,
    ]);
  }
  removeCustomResolversInZotero(resolvers: CustomResolver[]) {
    this.replaceCustomResolversInZotero(
      this.customResolvers.filter(
        (entry) =>
          !resolvers.some((resolver) => isCustomResolverEqual(entry, resolver)),
      ),
    );
  }
  removeAllCustomResolversInZotero() {
    this.removeCustomResolversInZotero(this.customResolvers);
  }
  private get customResolversInZotero() {
    const values = Zotero.Prefs.get(
      CustomResolverManager.zoteroCustomResolversPrefKey,
      true,
    );
    if (typeof values !== "string") {
      return [];
    }
    let result = JSON.parse(values);
    if (!Array.isArray(result)) {
      result = [result];
    }
    return result as CustomResolver[];
  }
  private set customResolversInZotero(resolvers: CustomResolver[]) {
    Zotero.Prefs.set(
      CustomResolverManager.zoteroCustomResolversPrefKey,
      JSON.stringify(resolvers),
      true,
    );
  }

  private init() {
    this.customResolvers = this.customResolvers.filter((value) =>
      this.customResolversInZotero.findIndex((e) =>
        isCustomResolverEqual(e, value),
      ),
    );
  }
}
