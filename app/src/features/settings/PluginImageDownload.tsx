import { useState } from "react";
import { useTranslation } from "../../i18n";
import { downloadPluginImage } from "../../lib/gateway";
import { DownloadIcon } from "../../shared/ui/icons";
import { Button } from "../../shared/ui/primitives";
import { toast } from "../../store/toastStore";
import type { PluginListImage } from "../../types";

/** Export through the native host: WebView downloads vary between platforms. */
export function PluginImageDownload({ pluginId, image }: { pluginId: string; image: PluginListImage }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await downloadPluginImage(pluginId, image.file, image.mime);
      toast(t("plugins.imageDownloaded", { path }));
    } catch (error) {
      toast(t("plugins.imageDownloadFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button small disabled={busy} onClick={() => void download()}>
      <DownloadIcon size={13} /> {busy ? t("plugins.saving") : t("plugins.downloadImage")}
    </Button>
  );
}
