import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { DOIManager } from "./DOIManager";
import { SciHubFetcher } from "./SciHubFetcher";

export class Common {
  private static readonly itemMenuID = "scipdf-itemmenu-scihub-fetch";

  static async registerPrefs() {
    const prefOptions = {
      pluginID: config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: getString("prefs-title"),
      image: `chrome://${config.addonRef}/content/icons/sci-hub-logo.svg`,
      defaultXUL: true,
    };
    await ztoolkit.getGlobal("Zotero").PreferencePanes.register(prefOptions);
  }

  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${config.addonRef}/content/icons/sci-hub-logo.svg`;

    // Resolve the target items without ever throwing. `getActiveZoteroPane()`
    // can be missing a pane in some window states, so guard every access.
    const resolveItems = (contextItems?: Zotero.Item[]): Zotero.Item[] => {
      if (contextItems && contextItems.length > 0) {
        return contextItems;
      }
      try {
        return Zotero.getActiveZoteroPane().getSelectedItems();
      } catch (error) {
        Zotero.debug(
          `[Sci-PDF] failed to read selected items: ${String(error)}`,
        );
        return [];
      }
    };

    if (Zotero.MenuManager) {
      if (addon.data.registeredMenuIDs.includes(this.itemMenuID)) {
        return;
      }
      let registeredMenuID: string | false = false;
      try {
        registeredMenuID = Zotero.MenuManager.registerMenu({
          menuID: this.itemMenuID,
          pluginID: config.addonID,
          target: "main/library/item",
          menus: [
            {
              menuType: "menuitem",
              icon: menuIcon,
              // onShowing runs synchronously while Zotero builds the context
              // menu popup. If it throws, the *whole* right-click menu fails to
              // open, so this must never be allowed to raise.
              onShowing: (_event, context) => {
                try {
                  context.menuElem.setAttribute(
                    "label",
                    getString("menuitem-fetch"),
                  );
                  context.setIcon(menuIcon);
                  const items = resolveItems(context.items);
                  context.setVisible(
                    items.some((item) => item.isRegularItem()),
                  );
                } catch (error) {
                  Zotero.debug(
                    `[Sci-PDF] failed to prepare context menu: ${String(error)}`,
                  );
                  try {
                    context.setVisible(false);
                  } catch {
                    // ignore: hiding is best-effort
                  }
                }
              },
              onCommand: (_event, context) => {
                SciHubFetcher.updateItems(resolveItems(context.items), false);
              },
            },
            {
              menuType: "menuitem",
              icon: menuIcon,
              onShowing: (_event, context) => {
                try {
                  context.menuElem.setAttribute(
                    "label",
                    getString("menuitem-verifydoi"),
                  );
                  context.setIcon(menuIcon);
                  const items = resolveItems(context.items);
                  context.setVisible(
                    items.some((item) => item.isRegularItem()),
                  );
                } catch (error) {
                  Zotero.debug(
                    `[Sci-PDF] failed to prepare verify-doi context menu: ${String(error)}`,
                  );
                  try {
                    context.setVisible(false);
                  } catch {
                    // ignore: hiding is best-effort
                  }
                }
              },
              onCommand: (_event, context) => {
                DOIManager.auditAndRepairItems(resolveItems(context.items));
              },
            },
          ],
        });
      } catch (error) {
        Zotero.debug(
          `[Sci-PDF] MenuManager.registerMenu failed, using legacy menu: ${String(error)}`,
        );
        registeredMenuID = false;
      }
      if (registeredMenuID) {
        addon.data.registeredMenuIDs.push(registeredMenuID);
        return;
      }
      // Registration failed: fall through to the legacy menu so the command
      // stays reachable instead of disappearing entirely.
    }

    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-itemmenu-scihub-fetch",
      label: getString("menuitem-fetch"),
      isHidden: () => {
        const items = resolveItems();
        return !items.some((item) => item.isRegularItem());
      },
      commandListener: () => {
        SciHubFetcher.updateItems(resolveItems(), false);
      },
      icon: menuIcon,
    });

    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-itemmenu-doi-verify",
      label: getString("menuitem-verifydoi"),
      isHidden: () => {
        const items = resolveItems();
        return !items.some((item) => item.isRegularItem());
      },
      commandListener: () => {
        DOIManager.auditAndRepairItems(resolveItems());
      },
      icon: menuIcon,
    });
  }

  static unregisterMenus() {
    for (const menuID of addon.data.registeredMenuIDs) {
      Zotero.MenuManager?.unregisterMenu(menuID);
    }
    addon.data.registeredMenuIDs = [];
  }
}
