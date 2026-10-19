import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { useAlertStore } from "../../store/alertStore";
import { usePluginsStore } from "../../store/pluginsStore";
import { commitSettingsDraft, useSettingsDraft } from "../../store/settingsDraft";
import { useWakeStore } from "../../store/wakeStore";
import { toast } from "../../store/toastStore";
import { Button, IconButton } from "../../shared/ui/primitives";
import { CloseIcon, UserIcon, MicIcon, WaveIcon, PlusIcon, SettingsIcon, DeviceIcon } from "../../shared/ui/icons";
import { TextField } from "../../shared/ui/controls";
import { matchesSearch } from "../../shared/lib/searchText";
import { pluginPages, SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPage } from "./sections";
import { TITLEBAR_HEIGHT, useWindowDrag } from "../../shared/hooks/useWindowDrag";

interface Props {
  open: boolean;
  onClose: () => void;
  pageIds?: readonly string[];
  extraPages?: readonly SettingsPage[];
  compactNavigation?: boolean;
  sessionControl?: ReactNode;
}
const GROUP_ICONS = {general:UserIcon,voice:MicIcon,tools:WaveIcon,plugins:PlusIcon,application:SettingsIcon,advanced:DeviceIcon};

/**
 * Full-window settings.
 *
 * A sidebar plus one page at a time, instead of every section stacked into a
 * narrow drawer: the old layout squeezed ten cards into 440px. The page itself
 * is the only thing that scrolls, so the navigation and the actions stay put.
 */
export function SettingsPanel({ open, onClose, pageIds, extraPages, compactNavigation = false, sessionControl }: Props) {
  const { t, locale } = useTranslation();
  const reset = useSettingsDraft((s) => s.resetPreferences);
  const discard = useSettingsDraft((s) => s.discard);
  const [saving, setSaving] = useState(false);

  const cancel = () => {
    discard();
    onClose();
  };

  const done = async () => {
    setSaving(true);
    try {
      await commitSettingsDraft();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const micNeedsPermission = useAlertStore((s) => s.micNeedsPermission);
  const wakeBlocked = useWakeStore((s) => s.blocked);
  const [activeId, setActiveId] = useState("overview");
  const [query, setQuery] = useState("");
  const [expandedGroups,setExpandedGroups]=useState<string[]>(["general","voice","plugins"]);
  const body = useRef<HTMLDivElement>(null);
  // The overlay covers the titlebar, so it has to be draggable itself: the
  // titlebar lane of the backdrop, the modal's header and the sidebar title.
  const drag = useWindowDrag();
  const dragged = useRef(false);

  // Every active plugin with something to show gets its own page, so plugin
  // settings do not pile up inside the Plugins list.
  const plugins = usePluginsStore((s) => s.plugins);
  const refreshPlugins = usePluginsStore((s) => s.refresh);
  const pages = useMemo<SettingsPage[]>(
    () => [
      ...SETTINGS_PAGES.filter((entry) => !pageIds || pageIds.includes(entry.id)),
      ...(extraPages ?? []),
      ...pluginPages(plugins, locale),
    ],
    [plugins, locale, pageIds, extraPages],
  );

  useEffect(() => {
    if (!open) return;
    discard();
    void refreshPlugins();
  }, [open, refreshPlugins, discard]);

  // Deactivating or uninstalling a plugin removes the page it owned; the user
  // must land somewhere that still exists.
  useEffect(() => {
    if (activeId !== "overview" && !pages.some((entry) => entry.id === activeId)) setActiveId("overview");
  }, [pages, activeId]);
  useEffect(()=>{body.current?.scrollTo?.({top:0});},[activeId]);
  useEffect(()=>{const group=pages.find((page)=>page.id===activeId)?.group;if(group)setExpandedGroups((current)=>current.includes(group)?current:[...current,group]);},[activeId,pages]);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        discard();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, discard]);

  if (!open) return null;

  const hasAlert = (page: SettingsPage) =>
    (page.alert === "mic" && micNeedsPermission) ||
    (page.alert === "wake" && !!wakeBlocked);

  const labelOf = (page: SettingsPage) =>
    page.labelKey ? t(page.labelKey) : (page.label ?? page.id);

  const page = pages.find((entry) => entry.id === activeId) ?? pages[0];
  const Active = page.Component;
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    pages: pages.filter((entry) => entry.group === group.id && matchesSearch(`${labelOf(entry)} ${t(group.labelKey)}`,query)),
  })).filter((group) => group.pages.length > 0);

  return (
    <div
      className="settings-overlay"
      onPointerDown={(event) => {
        dragged.current =
          event.target === event.currentTarget &&
          event.clientY <= TITLEBAR_HEIGHT &&
          drag(event);
      }}
      onClick={(event) => {
        // A drag that ends on the backdrop is not a request to close.
        if (dragged.current || event.target !== event.currentTarget) return;
        cancel();
      }}
    >
      <div
        className="settings-modal glass"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(event) => event.stopPropagation()}
      >
        {compactNavigation && <nav className="settings-compact-nav" aria-label={t("settings.title")}>
          <label>
            <span className="field-label">{t("settings.title")}</span>
            <select className="field" value={activeId} onChange={event => { setActiveId(event.target.value); setQuery(""); }}>
              <option value="overview">{t("settings.overview")}</option>
              {groups.map(group => <optgroup key={group.id} label={t(group.labelKey)}>
                {group.pages.map(entry => <option key={entry.id} value={entry.id}>{labelOf(entry)}</option>)}
              </optgroup>)}
            </select>
          </label>
        </nav>}
        <nav className="settings-nav">
          <div className="settings-nav-fixed">
          <div className="settings-nav-title" onPointerDown={drag}>
            {t("settings.title")}
          </div>
          <div className="settings-nav-search"><TextField label={t("settings.search")} value={query} onChange={setQuery}/></div>
          <button type="button" className={`settings-nav-item${activeId==="overview"?" on":""}`} aria-current={activeId==="overview"?"page":undefined}
            onClick={()=>{setActiveId("overview");setQuery("");}}>{t("settings.overview")}</button>
          </div>
          <div className="settings-nav-scroll">
          {groups.map((group) => {
            const Icon=GROUP_ICONS[group.id];const expanded=!!query.trim()||expandedGroups.includes(group.id);
            return (
            <div key={group.id} className="settings-nav-group" role="group" aria-labelledby={`settings-group-${group.id}`}>
              <button type="button" className="settings-nav-group-toggle" id={`settings-group-${group.id}`} aria-expanded={expanded}
                aria-controls={`settings-group-pages-${group.id}`} onClick={()=>setExpandedGroups((current)=>current.includes(group.id)?current.filter((id)=>id!==group.id):[...current,group.id])}>
                <Icon size={17}/><span>{t(group.labelKey)}</span>{group.pages.some(hasAlert)&&<i className="nav-dot" aria-hidden/>}
                <span className={`settings-group-chevron${expanded?" expanded":""}`} aria-hidden>›</span>
              </button>
              <div className="settings-nav-group-pages" id={`settings-group-pages-${group.id}`} hidden={!expanded}>
              {group.pages.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`settings-nav-item${entry.id === activeId ? " on" : ""}`}
                  aria-current={entry.id === activeId ? "page":undefined}
                  onClick={() => setActiveId(entry.id)}
                >
                  <span>{labelOf(entry)}</span>
                  {hasAlert(entry) && <i className="nav-dot" aria-hidden />}
                </button>
              ))}
              </div>
            </div>
          );})}
          {groups.length===0&&<p className="field-help settings-nav-empty">{t("settings.noMatches")}</p>}
          </div>
        </nav>

        <section className="settings-main">
          {sessionControl}
          <header className="settings-head" onPointerDown={drag}>
            <div><span className="settings-breadcrumb">{activeId==="overview"?t("settings.title"):t(SETTINGS_GROUPS.find((group)=>group.id===page.group)!.labelKey)}</span>
              <h2>{activeId==="overview"?t("settings.overview"):labelOf(page)}</h2></div>
            <IconButton label={t("common.close")} onClick={cancel}>
              <CloseIcon />
            </IconButton>
          </header>

          <div className="settings-body" ref={body}>
            <div className="settings-page">
              {activeId==="overview"?<>
                <p className="field-help settings-overview-intro">{t("settings.overviewHelp")}</p>
                {groups.length===0&&<div className="notice">{t("settings.noMatches")}</div>}
                <div className="settings-overview-grid">{groups.map((group)=><section className="set-group" key={group.id}>
                  <div className="sec settings-category-title">{(() => {const Icon=GROUP_ICONS[group.id];return <Icon size={18}/>;})()}{t(group.labelKey)}</div><div className="set-card settings-category-card">
                    {group.pages.map((entry)=><button type="button" key={entry.id} onClick={()=>setActiveId(entry.id)}>
                      <span>{labelOf(entry)}</span>{hasAlert(entry)?<i className="nav-dot" aria-hidden/>:<span aria-hidden>›</span>}
                    </button>)}
                  </div></section>)}</div>
            </>:<Active key={activeId} plugin={page.plugin} onNavigate={setActiveId} />}
            </div>
          </div>

          <footer className="settings-foot">
            <Button variant="ghost"
              onClick={() => {
                reset();
                toast(t("settings.resetToast"));
              }}
            >
              {t("settings.reset")}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void done()}>
              {t("settings.done")}
            </Button>
          </footer>
        </section>
      </div>
    </div>
  );
}
