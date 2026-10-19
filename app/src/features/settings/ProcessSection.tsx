import { ContentSkeleton } from "../../shared/ui/ContentSkeleton";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, processReport } from "../../lib/gateway";
import { useTranslation, type TranslationKey } from "../../i18n";
import { formatBytes, formatDuration } from "../../shared/lib/format";
import { Button, Section } from "../../shared/ui/primitives";
import type { ProcessKind, ProcessUsage } from "../../types";

const LABELS: Record<ProcessKind, TranslationKey> = {host:"process.host",plugins:"process.plugins",webviews:"process.webviews",media:"process.media",other:"process.other"};
const POLL_MS = 2000;
type Sample = {cpuSeconds:number;at:number};
export function sampledCpu(previous: Sample | null, current: Sample): number | null {
  if (!previous || current.at <= previous.at || current.cpuSeconds < previous.cpuSeconds) return null;
  const value=(current.cpuSeconds-previous.cpuSeconds)/(current.at-previous.at)*100_000;
  return Number.isFinite(value)?value:null;
}

/** Compact live totals with a component grid and optional diagnostic detail. */
export function ProcessSection() {
  const {t}=useTranslation();
  const [usage,setUsage]=useState<ProcessUsage|null>(null);
  const [failed,setFailed]=useState(false), [busy,setBusy]=useState(false);
  const [cpuNow,setCpuNow]=useState<number|null>(null), [history,setHistory]=useState<number[]>([]);
  const previous=useRef<Sample|null>(null), pending=useRef(false), alive=useRef(true);
  const refresh=useCallback(async()=>{
    if(!isTauri() || pending.current)return;
    pending.current=true;setBusy(true);
    try {
      const next=await processReport();if(!alive.current)return;
      const sample={cpuSeconds:next.cpuSeconds,at:Date.now()};
      const cpu=sampledCpu(previous.current,sample);previous.current=sample;
      setUsage(next);setCpuNow(cpu);setFailed(false);
      if(cpu!==null)setHistory((values)=>[...values,cpu].slice(-30));
      else setHistory([]);
    } catch {if(alive.current)setFailed(true);}
    finally {pending.current=false;if(alive.current)setBusy(false);}
  },[]);
  useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),POLL_MS);
    return()=>{alive.current=false;clearInterval(timer);};},[refresh]);
  if(!isTauri())return <Section title={t("process.title")}><div className="notice">{t("process.backendNotice")}</div></Section>;
  const average=usage&&usage.uptimeSeconds>0?usage.cpuSeconds/usage.uptimeSeconds*100:null;
  const max=Math.max(100,...history);
  const points=history.map((value,index)=>({x:history.length===1?160:index*320/(history.length-1),y:40-value/max*36}));
  const groups=usage?.groups.slice().sort((a,b)=>b.rssBytes-a.rssBytes)||[];
  return <div className="process-page">
    <div className="process-toolbar"><span className="muted small" role="status">{t(failed?"process.stale":"process.live")}</span>
      <Button small disabled={busy} onClick={()=>void refresh()}>{t("storage.refresh")}</Button></div>
    {failed&&<div className="errorbox" role="alert">{t(usage?"process.refreshFailed":"process.unavailable")}</div>}
    {!usage?failed ? <div className="notice" role="status">{t("process.unavailable")}</div> : <ContentSkeleton layout="cards" label={t("process.loading")} />:<>
      <div className="process-summary-grid">
        <section className="process-metric"><span className="muted small">{t("process.memoryTotal")}</span>
          <strong>{formatBytes(usage.rssBytes,t)}</strong><span className="muted small">{t("process.processes",{count:usage.processes})}</span>
        </section>
        <section className="process-metric"><span className="muted small">{t("process.cpuNow")}</span>
          <strong>{cpuNow===null?"—":`${cpuNow.toFixed(1)}%`}</strong>
          <svg viewBox="0 0 320 44" className="process-sparkline" role="img" aria-label={t("process.recentCpu")}>
            <title>{t("process.recentCpu")}</title><line x1="0" x2="320" y1="40" y2="40" className="plugin-chart-grid"/>
            {points.length>1&&<path d={points.map((point,index)=>`${index?"L":"M"}${point.x},${point.y}`).join(" ")} className="plugin-chart-line"/>}
            {points.length>0&&<circle cx={points.at(-1)!.x} cy={points.at(-1)!.y} r="2.5" className="plugin-chart-dot"/>}
          </svg>
        </section>
        <section className="process-small-metric"><span className="muted small">{t("process.threads")}</span><strong>{usage.threads}</strong></section>
        <section className="process-small-metric"><span className="muted small">{t("process.uptime")}</span><strong>{formatDuration(usage.uptimeSeconds)}</strong></section>
      </div>
      <section className="set-group"><div className="sec">{t("process.byComponent")}</div>
        <div className="process-components">{groups.map((group)=><article key={group.kind}>
          <h3>{t(LABELS[group.kind])}</h3><strong>{formatBytes(group.rssBytes,t)}</strong>
          <div className="plugin-progress-track" aria-hidden><div className="plugin-progress-value" style={{width:`${usage.rssBytes>0?Math.min(100,group.rssBytes/usage.rssBytes*100):0}%`}}/></div>
          <span className="muted small">{t("process.processes",{count:group.processes})}</span>
        </article>)}</div>
      </section>
      <details className="process-details"><summary>{t("process.details")}</summary>
        <div className="process-detail-totals"><span>{t("process.cpuAverage")}: {average===null?"—":`${average.toFixed(1)}%`}</span>
          <span>{t("process.cpuTime",{time:formatDuration(usage.cpuSeconds)})}</span></div>
        <table><thead><tr><th scope="col">{t("process.component")}</th><th scope="col">{t("process.memory")}</th><th scope="col">{t("process.cpu")}</th><th scope="col">{t("process.threads")}</th></tr></thead>
          <tbody>{groups.map((group)=><tr key={group.kind}><th scope="row">{t(LABELS[group.kind])}</th><td>{formatBytes(group.rssBytes,t)}</td><td>{formatDuration(group.cpuSeconds)}</td><td>{group.threads}</td></tr>)}</tbody></table>
        {history.length>0&&<p className="field-help">{t("process.recentCpu")}: {history.map((value)=>`${value.toFixed(1)}%`).join(", ")}</p>}
      </details>
    </>}
    <p className="field-help process-help">{t("process.help")}</p>
  </div>;
}
