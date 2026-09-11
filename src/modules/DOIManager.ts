import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";
import {
  verifyAndRepairItemDOI,
  DOIRepairReport,
} from "./DOICompleter";

export class DOIManager {
  private static isRunning = false;

  static async auditAndRepairItems(items: Zotero.Item[]): Promise<void> {
    const regularItems = items.filter((item) => item.isRegularItem());
    if (regularItems.length === 0) return;

    if (this.isRunning) {
      Utils.showPopWin(
        getString("popwin-doiverifying"),
        getString("popwin-busy-hint") || "Another DOI audit is currently in progress...",
        "default",
      );
      return;
    }

    this.isRunning = true;
    const total = regularItems.length;
    let validCount = 0;
    let repairedCount = 0;
    let unresolvedCount = 0;

    let email = "";
    try {
      email = (Zotero.Prefs.get("extensions.sci-pdf.email", true) as string) || "";
    } catch {
      // ignore
    }

    const win = Utils.showPopWin(
      getString("popwin-doiverifying"),
      regularItems[0].getDisplayTitle(),
      "default",
      -1,
    );

    try {
      for (let i = 0; i < total; i++) {
        const item = regularItems[i];
        win.changeLine({
          text: `(${i + 1}/${total}) ${item.getDisplayTitle()}`,
          progress: Math.round(((i + 1) / total) * 100),
        });

        const report: DOIRepairReport = await verifyAndRepairItemDOI(item, email);

        if (report.outcome === "valid") {
          validCount++;
        } else if (report.outcome === "repaired" || report.outcome === "completed") {
          repairedCount++;
          const title =
            report.outcome === "completed"
              ? getString("popwin-doicompleted")
              : report.detail === "mismatched"
                ? getString("popwin-doimismatched")
                : getString("popwin-doifixed");
          Utils.showPopWin(
            title,
            `${report.oldDOI || item.getDisplayTitle()} → ${report.newDOI}`,
            "success",
            3500,
          );
        } else {
          unresolvedCount++;
        }
      }

      // Finish progress window
      win.changeLine({
        text: getString("popwin-doirepairsummary", {
          args: {
            total: total.toString(),
            valid: validCount.toString(),
            repaired: repairedCount.toString(),
            failed: unresolvedCount.toString(),
          },
        }),
        type: repairedCount > 0 ? "success" : "default",
        progress: 100,
      });
      win.show(4000);
    } catch (err) {
      Zotero.debug(`[Sci-PDF] DOIManager execution failed: ${String(err)}`);
      win.changeLine({
        text: `Error: ${String(err)}`,
        type: "fail",
        progress: 100,
      });
      win.show(4000);
    } finally {
      this.isRunning = false;
    }
  }
}
