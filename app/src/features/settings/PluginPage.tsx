import { ContentSkeleton } from "../../shared/ui/ContentSkeleton";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { hasHost, isTauri, onPluginEvent, pluginImage, pluginSettings, runTool } from "../../lib/gateway";
import { copyText } from "../../lib/copyText";
import { useTranslation } from "../../i18n";
import { summaryOf } from "../../lib/toolResult";
import { usePluginsStore } from "../../store/pluginsStore";
import { refreshScene } from "../../store/sceneStore";
import { useSettingsDraft } from "../../store/settingsDraft";
import { useSessionStore } from "../../store/sessionStore";
import { toast } from "../../store/toastStore";
import { RangeSlider, SelectField, Switch, TextField } from "../../shared/ui/controls";
import { StatusBadge, type StatusTone } from "../../shared/ui/StatusBadge";
import { Button } from "../../shared/ui/primitives";
import { PlayIcon } from "../../shared/ui/icons";
import { PluginImageDownload } from "./PluginImageDownload";
import { PluginDashboard } from "./PluginDashboard";
import { pluginPresentation } from "../../lib/pluginPresentation";
import { localizedPluginUi, localizedPluginItem, pluginText } from "../../lib/pluginLocalization";
import type {
  PluginListImage,
  PluginListItem,
  PluginListSource,
  PluginSettingField,
  PluginStatusRow,
  PluginUiAction,
  PluginUi,
  PluginView,
} from "../../types";

/** State chips reuse the app's vocabulary: ok / warn / bad / neutral. */
const STATUS_TONE: Record<string, StatusTone> = { ok: "positive", warn: "warning", bad: "negative" };

/** The navigation id of a plugin's own page. */
export function pluginPageId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

function StatusChip({ row }: { row: PluginStatusRow }) {
  const tone = STATUS_TONE[row.state ?? ""] ?? "neutral";
  if (row.value.length > 48 || row.value.includes("\n")) {
    return <div className={`plugin-status-description ${row.state ?? ""}`}>
      <span className="plugin-status-label">{row.label}</span>
      <p>{row.value}</p>
    </div>;
  }
  return (
    <div className="row between">
      <span className="muted small">{row.label}</span>
      <StatusBadge tone={tone}>{row.value}</StatusBadge>
    </div>
  );
}

async function reflectPluginChange(): Promise<void> {
  await Promise.all([usePluginsStore.getState().refresh(), refreshScene()]);
}

/** Explicit controls may change a live voice mode; background list reads never do. */
async function relayActionContext(result: unknown): Promise<void> {
  if (!result || typeof result !== "object" || !("context" in result) || typeof result.context !== "string") return;
  const session = useSessionStore.getState();
  if (session.connectionState !== "connected") return;
  // Awaiting also preserves order when the panel proxies these actions to the owner.
  await session.interrupt();
  const current = useSessionStore.getState();
  if (current.connectionState === "connected") {
    await current.sendText("[LILO] The user explicitly selected this plugin action. Apply its latest mode and follow the result: " + JSON.stringify({summary:summaryOf(result),context:result.context}).slice(0,12000), {hidden:true});
  }
}

/** Run one of the plugin's actions with feedback; `after` runs on success. */
function useRunAction(action: PluginUiAction, after?: () => void) {
  const { t } = useTranslation();
  const runTool = useSessionStore((s) => s.runTool);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await runTool(action.tool, action.args ?? {});
      await relayActionContext(result);
      // A plugin that describes its own result shows it; one that does not
      // still gets feedback, because a button that looks dead is a bug.
      toast(summaryOf(result) ?? t("plugins.actionDone", { label: action.label }));
      await reflectPluginChange();
      after?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return { busy, run };
}

function ActionRow({ action, after }: { action: PluginUiAction; after?: () => void }) {
  const { t } = useTranslation();
  const { busy, run } = useRunAction(action, after);
  const [confirm, setConfirm] = useState(false);

  return (
    <>
    <div className="row between">
      <span className="muted small">{action.label}</span>
      <Button small disabled={busy} onClick={() => action.requiresConfirm ? setConfirm(true) : void run()}>
        <PlayIcon size={13} /> {busy ? t("plugins.saving") : t("plugins.runNow")}
      </Button>
    </div>
    {confirm && <div className="overlay"><div className="set-card plugin-delete-confirm" role="alertdialog" aria-modal="true">
      <p>{t("plugins.confirmAction", {label:action.label})}</p>
      <div className="plugin-list-actions"><Button small disabled={busy} onClick={() => {setConfirm(false);void run();}}>{t("plugins.confirmRun")}</Button>
        <Button small disabled={busy} onClick={() => setConfirm(false)}>{t("plugins.cancelEdit")}</Button></div>
    </div></div>}
    </>
  );
}

function ToolCard({title,tool,max,revision,plugin}:{title:string;tool:string;max?:number;revision:number;plugin:PluginView}) {
  const {t,locale}=useTranslation();const [data,setData]=useState<Record<string,unknown>|null>(null);const [failed,setFailed]=useState(false);
  const text=pluginText(plugin.ui,locale);
  useEffect(()=>{let live=true;let off:(()=>void)|undefined;let requested=0;
    const load=()=>{const current=++requested;runTool(tool,{}).then((v)=>{if(live&&current===requested){setData(v&&typeof v==="object"?v as Record<string,unknown>:{});setFailed(false);}},()=>{if(live&&current===requested)setFailed(true);});};
    load();if(isTauri())void onPluginEvent((event)=>{if(event.source===plugin.manifest.id)load();}).then((unlisten)=>{if(live)off=unlisten;else unlisten();});
    return()=>{live=false;off?.();};},[tool,revision,plugin.manifest.id]);
  const value=data?.value;const percent=typeof value==="number"&&Number.isFinite(value)&&max?Math.max(0,Math.min(100,value/max*100)):null;
  return <div className={`set-group${data?.dashboard?" plugin-wide-card":""}`}><div className="sec">{title}</div><div className="set-card plugin-data-card">
    {failed?<span className="muted small">{t("plugins.cardFailed")}</span>:!data?<ContentSkeleton label={t("plugins.loadingCard")}/>:<>
      {typeof data.title==="string"&&data.title.length<=160&&<div className="plugin-list-label">{text(data.title)}</div>}
      {typeof data.detail==="string"&&data.detail.length<=1200&&<div className="muted small">{text(data.detail)}</div>}
      <PluginDashboard value={data.dashboard} translate={text}/>
      {percent!==null&&<div className="plugin-progress" role="progressbar" aria-valuenow={value as number} aria-valuemin={0} aria-valuemax={max}>
        <div className="plugin-progress-track"><div className="plugin-progress-value" style={{width:`${percent}%`}}/></div>
        <span className="muted small">{typeof data.label==="string"&&data.label.length<=400?data.label:`${value} / ${max}`}</span></div>}
    </>}
  </div></div>;
}

function PluginForm({form,after}:{form:NonNullable<PluginUi["forms"]>[number];after:()=>void}) {
  const {t}=useTranslation();const runTool=useSessionStore((s)=>s.runTool);const [busy,setBusy]=useState(false);const [invalid,setInvalid]=useState(false);
  const [values,setValues]=useState<Record<string,unknown>>(()=>Object.fromEntries(form.fields.map((f)=>[f.key,f.kind==="switch"?false:f.kind==="select"?(f.options?.[0]?.value??""):""])));
  const submit=async()=>{const bad=!validPluginFormValues(form.fields,values);setInvalid(bad);if(bad)return;
    setBusy(true);try{const result=await runTool(form.tool,values);toast(summaryOf(result)??t("plugins.saved"));after();}catch(error){toast(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
  return <div className="set-group"><div className="sec">{form.title}</div><div className="set-card plugin-form">
    {form.fields.map((field)=>{const set=(v:unknown)=>setValues((prev)=>({...prev,[field.key]:v}));switch(field.kind){
      case "switch":return <div className="row between" key={field.key}><span className="muted small">{field.label}</span><Switch checked={values[field.key]===true} onChange={(v)=>set(v)} label={field.label}/></div>;
      case "select":return <SelectField key={field.key} label={field.label} value={String(values[field.key]??"")} options={field.options??[]} onChange={set}/>;
      case "number":return <TextField key={field.key} label={field.label} value={String(values[field.key]??"")} onChange={(v)=>set(v===""?"":Number(v))}/>;
      default:return <TextField key={field.key} label={field.label} value={String(values[field.key]??"")} onChange={set}/>;
    }})}
    {invalid&&<div className="errorbox">{t("plugins.formInvalid")}</div>}
    <div className="plugin-form-submit"><Button small disabled={busy} onClick={()=>void submit()}>{busy?t("plugins.saving"):form.submitLabel}</Button></div>
  </div></div>;
}

/**
 * The rows a list tool returned. The result comes from a plugin, so anything
 * that is not a labelled row is dropped rather than rendered.
 */
export function validPluginFormValues(fields:NonNullable<PluginUi["forms"]>[number]["fields"],values:Record<string,unknown>):boolean {
  return !fields.some((field)=>{const value=values[field.key];if(field.required&&(value===""||value===undefined))return true;if(value===""||value===undefined)return false;
    if(field.kind==="text")return typeof value!=="string"||value.length>(field.maxLength??600);
    if(field.kind==="number")return typeof value!=="number"||!Number.isFinite(value)||(field.min!==undefined&&value<field.min)||(field.max!==undefined&&value>field.max);
    if(field.kind==="select")return !field.options?.some((option)=>option.value===value);
    return typeof value!=="boolean";});
}

export function listItems(result: unknown, ownedTools?: ReadonlySet<string>): PluginListItem[] {
  const items = (result as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const rows: PluginListItem[] = [];
  const boundedArgs = (args: unknown): Record<string, unknown> | undefined => {
    if (args === undefined) return {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    try { return JSON.stringify(args).length <= 8192 ? args as Record<string, unknown> : undefined; }
    catch { return undefined; }
  };
  const owns = (tool: string) => tool.length <= 128 && (!ownedTools || ownedTools.has(tool));
  for (const raw of items.slice(0,64)) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item.label !== "string" || !item.label.trim() || item.label.length > 400
      || (typeof item.detail === "string" && item.detail.length > 8000)) continue;
    const rawAction=item.action as Record<string,unknown>|null|undefined;
    const actionArgs=rawAction&&boundedArgs(rawAction.args);
    const action=rawAction&&typeof rawAction.tool==="string"&&owns(rawAction.tool)&&actionArgs
      ? {label:typeof rawAction.label==="string"?rawAction.label:item.label,tool:rawAction.tool,args:actionArgs}:null;
    const rawEdit=item.edit as Record<string,unknown>|null|undefined;
    const editArgs=rawEdit&&boundedArgs(rawEdit.args);
    const edit=rawEdit&&typeof rawEdit.tool==="string"&&owns(rawEdit.tool)&&typeof rawEdit.label==="string"
      &&typeof rawEdit.matchParameter==="string"&&typeof rawEdit.valueParameter==="string"
      &&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawEdit.matchParameter)&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawEdit.valueParameter)
      &&(rawEdit.value===undefined || (typeof rawEdit.value==="string" && rawEdit.value.length<=8000))
      &&editArgs? {tool:rawEdit.tool,label:rawEdit.label,matchParameter:rawEdit.matchParameter,valueParameter:rawEdit.valueParameter,
        ...(rawEdit.value!==undefined?{value:rawEdit.value as string}:{}),
        ...(rawEdit.args!==undefined?{args:editArgs}:{})}:null;
    const rawDelete=item.deleteAction as Record<string,unknown>|null|undefined;
    const deleteArgs=rawDelete&&boundedArgs(rawDelete.args);
    const deleteAction=rawDelete&&typeof rawDelete.tool==="string"&&owns(rawDelete.tool)&&typeof rawDelete.label==="string"&&deleteArgs
      ? {label:rawDelete.label,tool:rawDelete.tool,args:deleteArgs}:null;
    const image=item.image as Record<string,unknown>|null|undefined;
    rows.push({label:item.label,detail:typeof item.detail==="string"?item.detail:null,action,
      ...(edit?{edit}:{}),...(deleteAction?{deleteAction}:{}),
      image:image&&typeof image.file==="string"&&typeof image.mime==="string"?{file:image.file,mime:image.mime}:null});
  }
  return rows;
}

/**
 * A row's picture: a thumbnail that opens the full-size picture. The host
 * reads the file from the plugin's `data/` folder, never the plugin itself.
 */
function ListImage({ pluginId, image, label }: { pluginId: string; image: PluginListImage; label: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    setLoaded(false);
    setFailed(false);
    pluginImage(pluginId, image.file, image.mime).then(
      (url) => current && setSrc(url),
      () => { if (current) { setSrc(null); setFailed(true); } },
    );
    return () => {
      current = false;
    };
  }, [pluginId, image.file, image.mime]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (!src) return (
    <div className={`plugin-list-thumb plugin-list-thumb-placeholder${failed ? " is-failed" : " is-loading"}`} role="status" aria-label={failed ? t("plugins.imageLoadFailed") : t("plugins.imageLoading")}>
      {!failed && <span className="plugin-image-loader" aria-hidden="true" />}
    </div>
  );
  return (
    <>
      <button type="button" className={`plugin-list-thumb${loaded ? " is-loaded" : " is-loading"}`} onClick={() => setOpen(true)} title={t("plugins.openImage")} disabled={!loaded}>
        <img src={src} alt={label} onLoad={() => setLoaded(true)} onError={() => { setSrc(null); setFailed(true); }} />
        {!loaded && <span className="plugin-image-loader" role="status" aria-label={t("plugins.imageLoading")} />}
      </button>
      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <figure
            className="image-viewer"
            role="dialog"
            aria-label={label}
            onClick={(event) => event.stopPropagation()}
          >
            <img src={src} alt={label} />
            <figcaption className="muted small">{label}</figcaption>
            <PluginImageDownload pluginId={pluginId} image={image} />
          </figure>
        </div>
      )}
    </>
  );
}

function ListRow({ pluginId, item, after }: { pluginId: string; item: PluginListItem; after: () => void }) {
  const { t } = useTranslation();
  const idle = { label: "", tool: "" };
  const { busy, run } = useRunAction(item.action ?? idle, after);
  const runTool = useSessionStore((s) => s.runTool);
  const [editing, setEditing] = useState(false);
  const originalValue = item.edit?.value ?? item.detail ?? "";
  const [edited, setEdited] = useState(originalValue);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rowBusy, setRowBusy] = useState(false);
  useEffect(() => setEdited(originalValue), [originalValue]);
  const saveEdit = async () => {
    if (!item.edit || !originalValue || !edited.trim()) return;
    setRowBusy(true);
    try {
      const result = await runTool(item.edit.tool, {...item.edit.args,[item.edit.matchParameter]:originalValue,[item.edit.valueParameter]:edited.trim()});
      await relayActionContext(result);
      setEditing(false); after();
    } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
    finally { setRowBusy(false); }
  };
  const remove = async () => {
    if (!item.deleteAction) return;
    setRowBusy(true);
    try { const result = await runTool(item.deleteAction.tool,item.deleteAction.args ?? {}); await relayActionContext(result); setConfirmDelete(false); after(); }
    catch (error) { toast(error instanceof Error ? error.message : String(error)); }
    finally { setRowBusy(false); }
  };
  const copy = async () => {
    if (!item.detail) return;
    try { await copyText(item.detail); toast(t("plugins.copied")); }
    catch { toast(t("plugins.copyFailed")); }
  };

  return (
    <div className={`row between${item.image ? " plugin-list-row--media" : ""}`}>
      {item.image && <ListImage pluginId={pluginId} image={item.image} label={item.label} />}
      <div className="plugin-list-text">
        <div className="plugin-list-label" title={item.label}>
          {item.label}
        </div>
        {editing ? (
          <div className="plugin-note-editor">
            <TextField label={item.edit?.label ?? t("plugins.editNote")} value={edited} onChange={setEdited} multiline rows={3} />
            <div className="plugin-list-actions">
              <Button small disabled={rowBusy} onClick={() => void saveEdit()}>{t("plugins.saveNote")}</Button>
              <Button small disabled={rowBusy} onClick={() => { setEditing(false); setEdited(originalValue); }}>{t("plugins.cancelEdit")}</Button>
            </div>
          </div>
        ) : item.detail && <div className="plugin-list-detail muted small">{item.detail}</div>}
      </div>
      {(item.image || item.action || item.detail || item.edit || item.deleteAction) && (
        <div className="plugin-list-actions">
          {item.image && <PluginImageDownload pluginId={pluginId} image={item.image} />}
          {item.detail && <Button small onClick={() => void copy()}>{t("plugins.copyNote")}</Button>}
          {item.edit && <Button small disabled={rowBusy} onClick={() => setEditing(!editing)}>{t("plugins.editNote")}</Button>}
          {item.deleteAction && <Button small disabled={rowBusy} onClick={() => setConfirmDelete(true)}>{t("plugins.deleteNote")}</Button>}
          {item.action && (
            <Button small disabled={busy} onClick={() => void run()} title={item.action.label}>
              <PlayIcon size={13} /> {busy ? t("plugins.saving") : item.action.label}
            </Button>
          )}
        </div>
      )}
      {confirmDelete && item.deleteAction && (
        <div className="overlay" role="presentation">
          <div className="set-card plugin-delete-confirm" role="alertdialog" aria-modal="true" aria-label={t("plugins.confirmDeleteNote", {label:item.label})}>
            <p>{t("plugins.confirmDeleteNote", {label:item.label})}</p>
            <div className="plugin-list-actions">
              <Button small disabled={rowBusy} onClick={() => void remove()}>{t("plugins.deleteNote")}</Button>
              <Button small disabled={rowBusy} onClick={() => setConfirmDelete(false)}>{t("plugins.cancelEdit")}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A list whose rows the plugin produces while it runs. Read when the page
 * opens, after any of the page's actions, and whenever the plugin publishes
 * an event — its way of saying the rows changed.
 */
function PluginList({
  plugin,
  list,
  revision,
}: {
  plugin: PluginView;
  list: PluginListSource;
  revision: number;
}) {
  const { t, locale } = useTranslation();
  const [items, setItems] = useState<PluginListItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pluginId = plugin.manifest.id;
  const request = useRef(0);
  const live = useRef(false);

  // A read, not a user action: it stays out of the tool-run history.
  const load = useCallback(() => {
    if (!hasHost()) return;
    const current = ++request.current;
    runTool(list.tool, {}).then(
      (result) => {
        if (!live.current || current !== request.current) return;
        setItems(listItems(result,new Set(plugin.tools)));
        setFailure(null);
      },
      (error) => {
        if (live.current && current === request.current) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  }, [list.tool,plugin.tools]);

  useEffect(() => {
    live.current = true;
    load();
    let stopped = false;
    let off: (() => void) | undefined;
    void onPluginEvent((event) => {
      if (event.source === pluginId) load();
    }).then((unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    });
    return () => {
      stopped = true;
      live.current = false;
      request.current++;
      off?.();
    };
  }, [load, pluginId]);

  useEffect(() => {
    if (revision > 0) load();
  }, [revision, load]);

  return (
    <div className="set-group">
      <div className="sec">{list.title}</div>
      <div aria-busy={items === null && !failure} className={`set-card plugin-list-grid${items?.some((item) => item.image) ? " plugin-list-grid--media" : ""}`}>
        {failure ? (
          <div className="muted small">{t("plugins.listFailed", { message: failure })}</div>
        ) : items === null ? (
          <ContentSkeleton label={t("plugins.loadingCard")} />
        ) : items.length > 0 ? (
          items.map((item, index) => (
            <ListRow key={`${index}:${item.label}`} pluginId={pluginId} item={localizedPluginItem(plugin.ui, locale, item)} after={load} />
          ))
        ) : (
          <div className="muted small">{list.empty || t("plugins.listEmpty")}</div>
        )}
      </div>
    </div>
  );
}

/**
 * A plugin's declared settings.
 *
 * Values start from what the host stored and are sent back whole on save: the
 * host owns the file, the plugin receives them over the protocol.
 */
function SettingsForm({ plugin }: { plugin: PluginView }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState<Record<string, unknown>>({});
  const pending = useSettingsDraft((s) => s.plugins[plugin.manifest.id]);
  const setPluginValues = useSettingsDraft((s) => s.setPluginValues);
  const values = pending ?? stored;

  useEffect(() => {
    if (!hasHost()) return;
    // Declared defaults fill whatever the host has not stored yet, so what the
    // form shows is what gets saved.
    const withDefaults = (stored: Record<string, unknown>) => {
      const merged: Record<string, unknown> = {};
      for (const entry of plugin.ui.settings) {
        if (entry.default !== undefined && entry.default !== null) {
          merged[entry.key] = entry.default;
        }
      }
      return { ...merged, ...stored };
    };
    pluginSettings(plugin.manifest.id).then(
      (saved) => setStored(withDefaults(saved)),
      () => setStored(withDefaults({})),
    );
    // Only on mount: re-reading while the user types would discard the edit.
  }, [plugin.manifest.id]);

  const set = (key: string, value: unknown) =>
    setPluginValues(plugin.manifest.id, { ...values, [key]: value });

  const field = (entry: PluginSettingField) => {
    const raw = values[entry.key];
    switch (entry.kind) {
      case "switch":
        return (
          <div className="row between" key={entry.key}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{entry.label}</span>
            <Switch
              checked={raw === true}
              onChange={(next) => set(entry.key, next)}
              label={entry.label}
            />
          </div>
        );
      case "select":
        return (
          <SelectField
            key={entry.key}
            label={entry.label}
            value={typeof raw === "string" ? raw : ""}
            options={entry.options ?? []}
            onChange={(next) => set(entry.key, next)}
            help={entry.help ?? undefined}
          />
        );
      case "range": {
        const min = entry.min ?? 0;
        const max = entry.max ?? 100;
        const value = typeof raw === "number" ? raw : min;
        return (
          <RangeSlider
            key={entry.key}
            label={entry.label}
            min={min}
            max={max}
            value={value}
            help={entry.help??undefined}
            onChange={(next) => set(entry.key, next)}
          />
        );
      }
      default:
        return (
          <TextField
            key={entry.key}
            label={entry.label}
            type={entry.kind === "password" ? "password" : "text"}
            value={typeof raw === "string" ? raw : ""}
            onChange={(next) => set(entry.key, next)}
            placeholder={entry.placeholder ?? undefined}
            help={entry.help ?? undefined}
          />
        );
    }
  };

  return (
    <div className="set-group">
      <div className="sec">{t("plugins.settings")}</div>
      <div className="set-card">{plugin.ui.settings.map(field)}</div>
    </div>
  );
}

/**
 * One plugin's own page: its live status, the actions it offers and its
 * settings. The host renders it from the plugin's declarative description —
 * there is no per-plugin code in the app.
 */
export function PluginPage({ plugin: sourcePlugin }: { plugin: PluginView }) {
  const { t, locale } = useTranslation();
  const plugin = { ...sourcePlugin, ui: localizedPluginUi(sourcePlugin.ui, locale) };
  const presentation = pluginPresentation(plugin.manifest, locale);
  // Bumped by the page's own actions, so "Clear" empties the list at once
  // even from a plugin that publishes nothing.
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  const hasOverview=!!(plugin.ui.cards?.length||plugin.ui.progress?.length||plugin.ui.actions.length);
  const hasLibrary=!!(plugin.ui.list||plugin.ui.lists?.length);
  const formsInLibrary=hasLibrary&&!plugin.ui.cards?.length&&!plugin.ui.progress?.length;
  const tabs=[...(hasOverview?["overview"]:[]),...(hasLibrary?["library"]:[]),
    ...(plugin.ui.settings.length||plugin.ui.status.length||(!formsInLibrary&&plugin.ui.forms?.length)?["preferences"]:[])];
  const [selectedTab,setSelectedTab]=useState(hasOverview?"overview":hasLibrary?"library":"preferences");
  const activeTab=tabs.includes(selectedTab)?selectedTab:tabs[0];
  const tabLabel=(tab:string)=>tab==="overview"?t("plugins.overview"):tab==="library"?t("plugins.library"):t("plugins.preferences");
  return (
    <>
      {presentation.description && <p className="field-help plugin-description">{presentation.description}</p>}
      {tabs.length>1&&<div className="plugin-page-tabs" role="tablist" aria-label={presentation.name}>{tabs.map((tab)=><button key={tab} type="button" role="tab"
        id={`plugin-tab-${tab}`} aria-controls="plugin-tab-panel" aria-selected={activeTab===tab} tabIndex={activeTab===tab?0:-1}
        onClick={()=>setSelectedTab(tab)} onKeyDown={(event)=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();const index=(tabs.indexOf(tab)+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
          setSelectedTab(tabs[index]);document.getElementById(`plugin-tab-${tabs[index]}`)?.focus();}}}>{tabLabel(tab)}</button>)}</div>}
      <div id="plugin-tab-panel" role={tabs.length>1?"tabpanel":undefined} aria-labelledby={tabs.length>1?`plugin-tab-${activeTab}`:undefined} className={activeTab==="library"?"plugin-library-layout":"plugin-page-grid"}>
      {activeTab==="preferences"&&plugin.ui.status.length > 0 && (
        <div className="set-group">
          <div className="sec">{t("plugins.status")}</div>
          <div className="set-card">
            {plugin.ui.status.map((row) => (
              <StatusChip key={row.label} row={row} />
            ))}
          </div>
        </div>
      )}

      {activeTab==="library"&&formsInLibrary&&plugin.ui.forms?.map((form)=><PluginForm key={form.tool} form={form} after={bump}/>)}
      {activeTab==="library"&&plugin.ui.list && (
        <PluginList plugin={plugin} list={plugin.ui.list} revision={revision} />
      )}

      {activeTab==="library"&&plugin.ui.lists?.map((list, index) => (
        <PluginList key={`${index}:${list.tool}`} plugin={plugin} list={list} revision={revision} />
      ))}

      {activeTab==="overview"&&plugin.ui.cards?.map((card) => <ToolCard key={card.tool} title={card.title} tool={card.tool} revision={revision} plugin={plugin} />)}
      {activeTab==="overview"&&plugin.ui.progress?.map((item) => <ToolCard key={item.tool} title={item.title} tool={item.tool} max={item.max} revision={revision} plugin={plugin} />)}
      {activeTab==="preferences"&&!formsInLibrary&&plugin.ui.forms?.map((form) => <PluginForm key={form.tool} form={form} after={bump} />)}

      {activeTab==="overview"&&plugin.ui.actions.length > 0 && (
        <div className="set-group">
          <div className="sec">{t("plugins.actions")}</div>
          <div className="set-card">
            {plugin.ui.actions.map((action) => (
              <ActionRow key={action.tool + action.label} action={action} after={bump} />
            ))}
          </div>
        </div>
      )}

      {activeTab==="preferences"&&plugin.ui.settings.length > 0 && <SettingsForm plugin={plugin} />}
      </div>
    </>
  );
}
