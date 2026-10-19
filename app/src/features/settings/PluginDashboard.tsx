import { useId } from "react";

type Metric = { label: string; value: string; detail: string };
type Skill = { label: string; value: number | null; detail: string };
type Point = { label: string; value: number; detail: string };
type Series = { label: string; kind: "bars" | "line"; max: number; points: Point[] };
type Dashboard = {
  hero: Skill;
  metrics: Metric[];
  skills: Skill[];
  series: Series[];
  highlights: { label: string; detail: string }[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, limit = 400): value is string => typeof value === "string" && value.length <= limit && !!value.trim();
const number = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

/** Plugin card results are untrusted; bound every chart before rendering. */
export function dashboardData(value: unknown): Dashboard | null {
  const data = record(value), hero = record(data?.hero);
  if (!data || !hero || !text(hero.label) || !number(hero.value, 100) || !text(hero.detail, 800)) return null;
  const bounded = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit) : [];
  const metrics: Metric[] = bounded(data.metrics, 8).flatMap((raw) => {
    const item = record(raw);
    return item && text(item.label) && text(item.value, 80) && text(item.detail, 800)
      ? [{ label: item.label, value: item.value, detail: item.detail }] : [];
  });
  const skills: Skill[] = bounded(data.skills, 8).flatMap((raw) => {
    const item = record(raw);
    return item && text(item.label) && (item.value === null || number(item.value, 100)) && text(item.detail, 800)
      ? [{ label: item.label, value: item.value as number | null, detail: item.detail }] : [];
  });
  const series: Series[] = bounded(data.series, 3).flatMap((raw) => {
    const item = record(raw);
    if (!item || !text(item.label) || !number(item.max, 1_000_000) || item.max === 0 || (item.kind !== "bars" && item.kind !== "line")) return [];
    const points: Point[] = bounded(item.points, 60).flatMap((raw) => {
      const point = record(raw);
      return point && text(point.label, 80) && number(point.value, item.max as number) && text(point.detail, 400)
        ? [{ label: point.label, value: point.value, detail: point.detail }] : [];
    });
    return points.length ? [{ label: item.label, kind: item.kind, max: item.max, points }] : [];
  });
  const highlights = bounded(data.highlights, 6).flatMap((raw) => {
    const item = record(raw);
    return item && text(item.label) && text(item.detail, 1200) ? [{ label: item.label, detail: item.detail }] : [];
  });
  return { hero: { label: hero.label, value: hero.value, detail: hero.detail }, metrics, skills, series, highlights };
}

function HistoryChart({ series }: { series: Series }) {
  const id = useId();
  const coordinates = series.points.map((point, index) => ({
    x: 12 + index * 576 / Math.max(1, series.points.length - 1),
    y: 112 - point.value / series.max * 96,
  }));
  const path = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
  return <figure className="plugin-chart">
    <figcaption>{series.label}</figcaption>
    <svg viewBox="0 0 600 130" role="img" aria-labelledby={id} preserveAspectRatio="xMidYMid meet">
      <title id={id}>{series.label}</title>
      {[16, 64, 112].map((y) => <line key={y} x1="8" x2="592" y1={y} y2={y} className="plugin-chart-grid" />)}
      {series.kind === "line" ? <>
        <path d={`${path} L588,112 L12,112 Z`} className="plugin-chart-area" />
        <path d={path} className="plugin-chart-line" />
        {coordinates.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="3" className="plugin-chart-dot"><title>{series.points[index].label}: {series.points[index].value} · {series.points[index].detail}</title></circle>)}
      </> : coordinates.map((point, index) => <rect key={index} x={point.x - Math.min(7, 240 / series.points.length)} y={point.y}
        width={Math.min(14, 480 / series.points.length)} height={Math.max(1, 112 - point.y)} rx="3" className="plugin-chart-bar">
        <title>{series.points[index].label}: {series.points[index].value} · {series.points[index].detail}</title>
      </rect>)}
    </svg>
    <div className="plugin-chart-range"><span>{series.points[0].label}</span><span>0–{series.max}</span><span>{series.points.at(-1)?.label}</span></div>
    <details className="plugin-chart-table"><summary>{series.label}</summary><table><tbody>{series.points.map((point, index) =>
      <tr key={index}><th scope="row">{point.label}</th><td>{point.value}</td><td>{point.detail}</td></tr>)}</tbody></table></details>
  </figure>;
}

/** A generic, declarative dashboard. Plugins supply data, never markup. */
export function PluginDashboard({ value, translate = (text) => text }: { value: unknown; translate?: (text: string) => string }) {
  const source = dashboardData(value);
  const data = source && {
    hero: {...source.hero,label:translate(source.hero.label),detail:translate(source.hero.detail)},
    metrics:source.metrics.map((item)=>({...item,label:translate(item.label),detail:translate(item.detail)})),
    skills:source.skills.map((item)=>({...item,label:translate(item.label),detail:translate(item.detail)})),
    series:source.series.map((item)=>({...item,label:translate(item.label),points:item.points.map((point)=>({...point,detail:translate(point.detail)}))})),
    highlights:source.highlights.map((item)=>({...item,label:translate(item.label),detail:translate(item.detail)})),
  };
  if (!data) return null;
  return <div className="plugin-dashboard">
    <div className="plugin-journey-hero">
      <div className="plugin-journey-ring" style={{ background: `conic-gradient(var(--accent) ${(data.hero.value ?? 0) * 3.6}deg, var(--bg2) 0deg)` }}>
        <div><strong>{data.hero.value}%</strong></div>
      </div>
      <div><h3>{data.hero.label}</h3><p className="muted small">{data.hero.detail}</p></div>
    </div>
    <div className="plugin-journey-metrics">{data.metrics.map((metric, index) => <div key={index}>
      <span className="muted small">{metric.label}</span><strong>{metric.value}</strong><span className="muted small">{metric.detail}</span>
    </div>)}</div>
    <div className="plugin-journey-skills">{data.skills.map((skill, index) => <div key={index}>
      <div className="row between"><span>{skill.label}</span><strong>{skill.value === null ? "—" : `${skill.value}%`}</strong></div>
      <div className="plugin-progress-track" role={skill.value === null ? undefined : "progressbar"} aria-label={skill.label}
        aria-valuenow={skill.value ?? undefined} aria-valuemin={skill.value === null ? undefined : 0} aria-valuemax={skill.value === null ? undefined : 100}>
        <div className="plugin-progress-value" style={{ width: `${skill.value ?? 0}%` }} />
      </div><span className="muted small">{skill.detail}</span>
    </div>)}</div>
    {data.series.map((series, index) => <HistoryChart key={index} series={series} />)}
    <div className="plugin-journey-highlights">{data.highlights.map((item, index) => <div key={index}>
      <strong>{item.label}</strong><p className="muted small">{item.detail}</p>
    </div>)}</div>
  </div>;
}
