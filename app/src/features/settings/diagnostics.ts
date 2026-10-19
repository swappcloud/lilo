import { ownerCall } from "../../app/windowRole";
import { translate } from "../../i18n";
import { exportLogs } from "../../lib/gateway";
import { toast } from "../../store/toastStore";

/** Native menus and panels share one export in the owner window. */
export const downloadDiagnosticLogs = ownerCall("diagnostics.export", async (): Promise<void> => {
  try {
    if (await exportLogs(translate("diagnostics.saveTitle"))) toast(translate("diagnostics.saved"));
  } catch {
    toast(translate("diagnostics.failed"));
  }
});
