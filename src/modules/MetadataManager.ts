import { getString } from "../utils/locale";
import { runExclusive } from "./OperationGate";
import { Utils } from "../utils/utils";
import { enrichSingleItem, type EnrichmentReport } from "./MetadataEnricher";

export class MetadataManager {
  static async enrichItems(items: Zotero.Item[]): Promise<void> {
    const regularItems = items.filter((item) => item.isRegularItem());
    if (regularItems.length === 0) return;
    await runExclusive(() => this.runEnrich(regularItems));
  }

  private static async runEnrich(regularItems: Zotero.Item[]): Promise<void> {
    const total = regularItems.length;
    let enrichedCount = 0;
    let abstractCount = 0;
    let completeCount = 0;
    let notFoundCount = 0;

    let email = "";
    try {
      if (typeof Zotero !== "undefined" && Zotero?.Prefs?.get) {
        email =
          (Zotero.Prefs.get(
            "extensions.zotero.scipdf.email",
            true,
          ) as string) ||
          (Zotero.Prefs.get("extensions.sci-pdf.email", true) as string) ||
          "";
      }
    } catch {
      // ignore
    }

    const state = { cancelled: false };

    const win = Utils.showPopWin(
      getString("popwin-enriching"),
      regularItems[0].getDisplayTitle(),
      "default",
      0,
    );
    try {
      win.addDescription(getString("popwin-cancelhint"));
    } catch {
      // ignore
    }

    if (win?.win?.close) {
      const close = win.win.close.bind(win.win);
      win.win.close = () => {
        state.cancelled = true;
        close();
      };
    }

    try {
      for (let i = 0; i < total; i++) {
        if (state.cancelled) break;

        const item = regularItems[i];
        win.changeLine({
          text: `(${i + 1}/${total}) ${item.getDisplayTitle()}`,
          progress: Math.round(((i + 1) / total) * 100),
        });

        const report: EnrichmentReport = await enrichSingleItem(item, email);

        if (state.cancelled) break;

        if (report.outcome === "enriched") {
          enrichedCount++;
          if (report.updatedFields.includes("abstractNote")) {
            abstractCount++;
          }
          Utils.showPopWin(
            getString("popwin-enriched"),
            `${item.getDisplayTitle()} → +${report.updatedFields.join(", ")}`,
            "success",
            2500,
          );
        } else if (report.outcome === "already_complete") {
          completeCount++;
        } else {
          notFoundCount++;
        }

        if (i < total - 1 && !state.cancelled) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      if (state.cancelled) {
        Utils.showPopWin(
          getString("popwin-cancelled") || "Operation Cancelled",
          regularItems[0].getDisplayTitle(),
          "default",
          3000,
        );
        return;
      }

      // Finish progress window
      win.changeLine({
        text: getString("popwin-enrichsummary", {
          args: {
            total: total.toString(),
            enriched: enrichedCount.toString(),
            abstracts: abstractCount.toString(),
            complete: completeCount.toString(),
            failed: notFoundCount.toString(),
          },
        }),
        type: enrichedCount > 0 ? "success" : "default",
        progress: 100,
      });
      win.show(4000);
    } catch (err) {
      Zotero.debug(
        `[Sci-PDF] MetadataManager execution failed: ${String(err)}`,
      );
      win.changeLine({
        text: `Error: ${String(err)}`,
        type: "fail",
        progress: 100,
      });
      win.show(4000);
    }
  }
}
