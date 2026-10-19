import { ContentSkeleton } from "../../shared/ui/ContentSkeleton";
import { useCallback, useEffect, useState } from "react";

import { hasHost, marketplaceList, pluginInstall } from "../../lib/gateway";
import { useTranslation } from "../../i18n";
import { pluginPresentation } from "../../lib/pluginPresentation";
import { usePluginsStore } from "../../store/pluginsStore";
import { useSessionStore } from "../../store/sessionStore";
import { refreshScene } from "../../store/sceneStore";
import { toast } from "../../store/toastStore";
import { SelectField, Switch, TextField } from "../../shared/ui/controls";
import { CardHeader } from "../../shared/ui/CardHeader";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { Button, Section } from "../../shared/ui/primitives";
import type { CatalogEntry, PluginView } from "../../types";
import { pluginPageId } from "./PluginPage";
import type { SettingsPageProps } from "./sections";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One installed plugin, WordPress-style: what it is, whether it runs, and the
 * three things one does to it. Its settings, actions and status live on its
 * own page, never here.
 */
function PluginRow({
  plugin,
  busy,
  onToggle,
  onOpen,
  onUninstall,
  update,
  onUpdate,
}: {
  plugin: PluginView;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onOpen: () => void;
  onUninstall: () => void;
  update?: CatalogEntry;
  onUpdate: () => void;
}) {
  const { t, locale } = useTranslation();
  const presentation = pluginPresentation(plugin.manifest, locale);
  const state = !plugin.loaded ? (plugin.enabled ? "wait" : "") : "ok";
  const label = !plugin.loaded
    ? plugin.enabled
      ? t("plugins.notLoaded")
      : t("plugins.inactive")
    : t("plugins.active");
  const hasPage =
    plugin.enabled &&
    plugin.loaded &&
    (plugin.ui.settings.length > 0 ||
      plugin.ui.actions.length > 0 ||
      plugin.ui.status.length > 0 || Boolean(plugin.ui.list) || Boolean(plugin.ui.lists?.length) ||
      Boolean(plugin.ui.cards?.length) || Boolean(plugin.ui.progress?.length) || Boolean(plugin.ui.forms?.length));

  return (
    <div className="plugin-row">
      <CardHeader title={presentation.name}
        status={<StatusBadge tone={state === "ok" ? "positive" : state === "wait" ? "warning" : "neutral"}>{busy ? t("plugins.saving") : label}</StatusBadge>}
        controls={plugin.manageable ? <Switch checked={plugin.enabled} onChange={onToggle} label={plugin.enabled ? t("plugins.deactivate") : t("plugins.activate")} /> : undefined} />
      {presentation.description && <p className="field-help plugin-description">{presentation.description}</p>}
      <div className="row between">
        <span className="muted small">
          {t("plugins.version", { version: plugin.manifest.version })}
          {" · "}
          {t("plugins.api", { api: plugin.manifest.api })}
          {" · "}
          {plugin.manifest.capabilities.length > 0
            ? plugin.manifest.capabilities.map((capability) => capability === "conversation:read" ? t("plugins.conversationAccess") : capability).join(", ")
            : t("plugins.noCapabilities")}
        </span>

      </div>
      {(hasPage || plugin.manageable || update) && (
        <div className="row end plugin-row-controls card-actions">
          {update && <Button small disabled={busy || update.api > 1} onClick={onUpdate}>
            {t("plugins.update", {version:update.version})}
          </Button>}
          {hasPage && (
            <Button small onClick={onOpen}>
              {t("plugins.configure")}
            </Button>
          )}
          {plugin.manageable && (
            <Button small disabled={busy} onClick={onUninstall}>
              {t("plugins.uninstall")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Plugins: what is installed, the marketplace to add more, and one switch per
 * plugin. The UI a plugin contributes is rendered from its own description on
 * the plugin's page — there is no per-plugin code in the app, which is what
 * makes a third-party plugin possible without shipping a UI framework to it.
 */
export function PluginsSection({ onNavigate }: SettingsPageProps) {
  const { t, locale } = useTranslation();
  const plugins = usePluginsStore((s) => s.plugins);
  const pluginsLoaded = usePluginsStore((s) => s.loaded);
  const loadError = usePluginsStore((s) => s.error);
  const refreshPlugins = usePluginsStore((s) => s.refresh);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const uninstallPlugin = usePluginsStore((s) => s.uninstall);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  // Kept local: the marketplace URL is a settings field, not plugin state.
  const settings = useSessionStore((s) => s.settings);
  const saveSettings = useSessionStore((s) => s.saveSettings);
  const [marketUrl, setMarketUrl] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const updates = new Map((catalog??[]).filter((entry)=>entry.installed && entry.updateAvailable).map((entry)=>[entry.id,entry]));
  const visiblePlugins = filter === "updates" ? plugins.filter((plugin)=>updates.has(plugin.manifest.id)) : plugins;
  const visibleCatalog = filter === "updates" ? catalog?.filter((entry)=>entry.installed && entry.updateAvailable) : catalog;

  useEffect(() => {
    setMarketUrl(settings?.marketplaceUrl ?? "");
  }, [settings?.marketplaceUrl]);

  const configured = settings != null;

  const loadCatalog = useCallback(async () => {
    setMarketError(null);
    try {
      setCatalog(await marketplaceList());
    } catch (err) {
      setCatalog([]);
      setMarketError(
        t("plugins.installFailed", {
          error: errorText(err),
        }),
      );
    }
  }, [t]);

  useEffect(() => {
    if (configured) void loadCatalog();
  }, [configured, loadCatalog]);

  const saveUrl = async () => {
    if (!settings) return;
    await saveSettings({ ...settings, marketplaceUrl: marketUrl.trim() });
    await loadCatalog();
  };

  const install = async (entry: CatalogEntry) => {
    setBusyId(entry.id);
    setMarketError(null);
    try {
      await pluginInstall(entry.id);
      toast(
        entry.installed
          ? t("plugins.updated_toast", { name: pluginPresentation(entry, locale).name, version: entry.version })
          : t("plugins.installed_toast", { name: pluginPresentation(entry, locale).name }),
      );
      await Promise.all([refreshPlugins(), loadCatalog()]);
      void refreshScene();
    } catch (err) {
      setMarketError(
        t("plugins.installFailed", {
          error: errorText(err),
        }),
      );
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (id: string, name: string) => {
    setBusyId(id);
    try {
      await uninstallPlugin(id);
      toast(t("plugins.uninstalled_toast", { name }));
      await loadCatalog();
      void refreshScene();
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (plugin: PluginView, next: boolean) => {
    const id = plugin.manifest.id;
    setBusyId(id);
    try {
      await setEnabled(id, next);
      void refreshScene();
      toast(
        next
          ? t("plugins.activated_toast", { name: pluginPresentation(plugin.manifest, locale).name })
          : t("plugins.deactivated_toast", { name: pluginPresentation(plugin.manifest, locale).name }),
      );
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusyId(null);
    }
  };

  if (!hasHost()) {
    return (
      <Section title={t("plugins.title")}>
        <div className="notice">{t("plugins.subtitle")}</div>
      </Section>
    );
  }

  return (
    <>
      <div className="set-group">
        <div className="sec">{t("plugins.marketTitle")}</div>
        <div className="set-card">
          <TextField
            label={t("plugins.marketUrl")}
            value={marketUrl}
            onChange={setMarketUrl}
            placeholder={t("plugins.marketPlaceholder")}
            help={t("plugins.marketHelp")}
          />
          <div className="btn-stack">
            <Button small onClick={() => void saveUrl()}>
              {t("plugins.marketRefresh")}
            </Button>
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="sec">{t("plugins.installedTitle")}</div>
        <div className="set-card plugin-filter-card"><SelectField label={t("plugins.filter")} value={filter} onChange={setFilter}
          options={[{value:"all",label:t("plugins.filterAll")},{value:"updates",label:t("plugins.filterUpdates",{count:updates.size})}]}/></div>
        {pluginsLoaded && plugins.length === 0 && !loadError && (
          <div className="notice">{t("plugins.empty")}</div>
        )}
        {loadError && (
          <div className="errorbox">{t("plugins.loadFailed", { error: loadError })}</div>
        )}
        {filter === "updates" && visiblePlugins.length === 0 && catalog !== null && <div className="notice">{t("plugins.noUpdates")}</div>}
        {visiblePlugins.length > 0 && (
          <div className="plugin-catalog-grid">
            {visiblePlugins.map((plugin) => (
              <PluginRow
                key={plugin.manifest.id}
                plugin={plugin}
                busy={busyId !== null}
                update={plugin.manageable ? updates.get(plugin.manifest.id) : undefined}
                onUpdate={()=>{const entry=updates.get(plugin.manifest.id);if(entry)void install(entry);}}
                onToggle={(next) => void toggle(plugin, next)}
                onOpen={() => onNavigate(pluginPageId(plugin.manifest.id))}
                onUninstall={() =>
                  void uninstall(plugin.manifest.id, pluginPresentation(plugin.manifest, locale).name)
                }
              />
            ))}
          </div>
        )}
      </div>

      {configured && (
        <div className="set-group">
          <div className="sec">{t("plugins.catalogTitle")}</div>
          {marketError && <div className="errorbox">{marketError}</div>}
          {catalog === null ? (
            <ContentSkeleton layout="cards" label={t("plugins.marketLoading")} />
          ) : visibleCatalog?.length === 0 ? (
            !marketError && <div className="notice">{t(filter==="updates"?"plugins.noUpdates":"plugins.catalogEmpty")}</div>
          ) : (
            <div className="plugin-catalog-grid">
              {visibleCatalog?.map((entry) => (
                <div className="catalog-row" key={entry.id}>
                  <CardHeader title={pluginPresentation(entry, locale).name}
                    status={<StatusBadge>{entry.installed ? t("plugins.installed", {version: entry.installedVersion ?? "?"}) : t("plugins.notInstalled")}</StatusBadge>} />
                  <div className="row between">
                    <span className="muted small">
                      {(entry.capabilities ?? []).map((capability) => capability === "conversation:read" ? t("plugins.conversationAccess") : capability).join(", ") ||
                        t("plugins.noCapabilities")}
                    </span>
                    <span className="status-chip">{entry.version}</span>
                  </div>
                  {pluginPresentation(entry, locale).description && (
                    <p className="field-help plugin-description">{pluginPresentation(entry, locale).description}</p>
                  )}
                  {entry.api !== 1 && (
                    <p className="field-help">
                      {t("plugins.needsNewer", { api: entry.api })}
                    </p>
                  )}
                  <div className="btn-stack card-actions">
                    <Button
                      small
                      disabled={busyId !== null || (entry.installed && !entry.updateAvailable)}
                      onClick={() => void install(entry)}
                    >
                      {busyId === entry.id
                        ? t("plugins.installing")
                        : entry.updateAvailable
                          ? t("plugins.update", { version: entry.version })
                          : entry.installed
                            ? t("plugins.upToDate")
                            : t("plugins.install")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
