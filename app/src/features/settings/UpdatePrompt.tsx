import { useEffect, useRef } from "react";
import { useTranslation } from "../../i18n";
import { call } from "../../lib/gateway";
import { useSessionStore } from "../../store/sessionStore";
import { useUpdateStore } from "../../store/updateStore";

/** The OS dialog also fits companion mode and never interrupts a live call. */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const info = useUpdateStore((state) => state.info);
  const connection = useSessionStore((state) => state.connectionState);
  const dismissed = useRef("");
  const prompting = useRef(false);
  useEffect(() => {
    if (info?.status !== "available" || !info.installable || !info.version || dismissed.current === info.version || prompting.current
      || connection === "connected" || connection === "connecting") return;
    const version = info.version;
    prompting.current = true;
    void call<boolean>("app_update_confirm", {
      version, title: t("update.title"), message: t("update.confirm", { version }),
      confirmLabel: t("update.install"), cancelLabel: t("update.later"),
    }).then((accepted) => {
      dismissed.current = version;
      if (accepted && useUpdateStore.getState().info?.version === version) void useUpdateStore.getState().install();
    }, () => { dismissed.current = version; }).finally(() => { prompting.current = false; });
  }, [info, connection, t]);
  return null;
}
