import { useEffect, useState } from "react";
import { isTauri, listCommands } from "../../lib/gateway";
import { useTranslation } from "../../i18n";
import { usePreferencesStore } from "../../store/preferencesStore";
import { usePluginsStore } from "../../store/pluginsStore";
import { pluginPresentation } from "../../lib/pluginPresentation";
import { SelectField, TextField } from "../../shared/ui/controls";
import { SlidePanel } from "../../shared/ui/primitives";
import type { CommandManifestEntry, PluginView } from "../../types";
import { matchesSearch } from "../../shared/lib/searchText";

type Labels = {music:string;conversation:string;other:string};
export function commandGroups(commands: CommandManifestEntry[], plugins: PluginView[], locale: string, labels: Labels) {
  const groups = new Map<string, {id:string;label:string;items:CommandManifestEntry[]}>();
  for (const command of commands) {
    const plugin = command.tool ? plugins.find((plugin)=>plugin.tools.includes(command.tool!)) : undefined;
    const id = command.name.startsWith("media.") ? "music" : command.name === "end-call" ? "conversation" : plugin?.manifest.id ?? command.name.split(".")[0];
    const label = id === "music" ? labels.music : id === "conversation" ? labels.conversation : plugin ? pluginPresentation(plugin.manifest,locale).name : labels.other;
    const group = groups.get(id) ?? {id,label,items:[]};
    group.items.push(command);groups.set(id,group);
  }
  return [...groups.values()];
}
export function matchingCommands(commands: CommandManifestEntry[], query: string) {
  return commands.filter((command)=>matchesSearch([command.description,...command.examples].join(" "),query));
}

/** A searchable command library with compact examples and plugin categories. */
export function CommandsPanel({open,onClose}:{open:boolean;onClose:()=>void}) {
  const {t,locale}=useTranslation();
  const wakePhrase=usePreferencesStore((state)=>state.wakePhrase);
  const plugins=usePluginsStore((state)=>state.plugins);
  const refreshPlugins=usePluginsStore((state)=>state.refresh);
  const [commands,setCommands]=useState<CommandManifestEntry[]>([]);
  const [loading,setLoading]=useState(false), [failed,setFailed]=useState(false);
  const [query,setQuery]=useState(""), [category,setCategory]=useState("all");
  useEffect(()=>{
    if(!open || !isTauri())return;
    let active=true;setLoading(true);setFailed(false);
    void refreshPlugins();
    listCommands(locale).then((items)=>{if(active)setCommands(items);},()=>{if(active)setFailed(true);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[open,locale,refreshPlugins]);
  const groups=commandGroups(commands,plugins,locale,{music:t("commands.groupMusic"),conversation:t("commands.groupConversation"),other:t("commands.groupOther")});
  const activeCategory=groups.some((group)=>group.id===category)?category:"all";
  const visible=groups.filter((group)=>activeCategory==="all" || group.id===activeCategory).map((group)=>({...group,
    items:query.trim()&&matchesSearch(group.label,query)?group.items:matchingCommands(group.items,query)})).filter((group)=>group.items.length);
  return <SlidePanel title={t("commands.title")} open={open} onClose={onClose} wide>
    <div className="command-library-toolbar">
      <p className="field-help">{t("commands.wakeHint",{phrase:wakePhrase})}</p>
      <div className="command-library-filters">
        <TextField label={t("commands.search")} value={query} onChange={setQuery} placeholder={t("commands.searchPlaceholder")}/>
        <SelectField label={t("commands.category")} value={groups.some((group)=>group.id===category)?category:"all"} onChange={setCategory}
          options={[{value:"all",label:t("commands.all")},...groups.map((group)=>({value:group.id,label:`${group.label} (${group.items.length})`}))]}/>
      </div>
      <div className="command-library-meta"><span>{t("commands.count",{count:visible.reduce((sum,group)=>sum+group.items.length,0)})}</span>
        <span>{t("commands.placeholderHint")}</span></div>
    </div>
    <div className="sbody command-library-body">
      {!isTauri()?<div className="notice">{t("commands.needsDesktop")}</div>:loading?<div className="notice">{t("commands.loading")}</div>:
        failed?<div className="errorbox">{t("commands.loadFailed")}</div>:visible.length===0?<div className="notice">{t("commands.noMatches")}</div>:
        visible.map((group)=><section className="set-group" key={group.id}>
          <div className="sec command-group-heading">{group.label}<span>{group.items.length}</span></div>
          <div className="command-library-grid">{group.items.map((command)=><article className="cmd-card" key={command.name}>
            <code className="command-primary-example">{command.examples[0]??command.description}</code>
            <p className="command-description">{command.description}</p>
            <div className="command-card-meta">{command.requiresConfirm && <span className="command-confirm-label">{t("commands.confirmation")}</span>}</div>
            {command.examples.length>1&&<details><summary>{t("commands.moreExamples",{count:command.examples.length-1})}</summary>
              <div className="cmd-phrases">{command.examples.slice(1).map((example,index)=><code key={index}>{example}</code>)}</div></details>}
          </article>)}</div>
        </section>)}
    </div>
  </SlidePanel>;
}
