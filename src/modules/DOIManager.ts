import { getString } from "../utils/locale";
import { runExclusive } from "./OperationGate";
import { Utils } from "../utils/utils";
import { verifyAndRepairItemDOI, DOIRepairReport } from "./DOICompleter";

export class DOIManager {
  static async auditAndRepairItems(items: Zotero.Item[]): Promise<void> {
    const regularItems = items.filter((item) => item.isRegularItem());
    if (regularItems.length === 0) return;
    await runExclusive(() => this.runAudit(regularItems));
  }

  private static async runAudit(regularItems: Zotero.Item[]): Promise<void> {
    const total = regularItems.length;
    let validCount = 0;
    let repairedCount = 0;
    let unresolvedCount = 0;

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
      getString("popwin-doiverifying"),
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

        const report: DOIRepairReport = await verifyAndRepairItemDOI(
          item,
          email,
        );

        if (state.cancelled) break;

        if (report.outcome === "valid") {
          validCount++;
        } else if (
          report.outcome === "repaired" ||
          report.outcome === "completed"
        ) {
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
            3000,
          );
        } else {
          unresolvedCount++;
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
    }
  }
}
