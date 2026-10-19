import { useMemo, useState } from "react";

import { useSessionStore } from "../../store/sessionStore";
import { useTranslation } from "../../i18n";
import { TextField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { SearchIcon } from "../../shared/ui/icons";
import { matchesSearch } from "../../shared/lib/searchText";

export function ToolsSection() {
  const { t } = useTranslation();
  const tools = useSessionStore((s) => s.tools);
  const runs = useSessionStore((s) => s.toolRuns);
  const runTool = useSessionStore((s) => s.runTool);
  const backendAvailable = useSessionStore((s) => s.backendAvailable);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => tools.filter((tool) => matchesSearch(`${tool.name} ${tool.description}`, filter)), [tools, filter]);
  const available = (name: string) => backendAvailable && tools.some((tool) => tool.name === name);

  const run = async (name: string, args: Record<string, unknown>) => {
    if (busy || !available(name)) return;
    setError(null);
    setBusy(name);
    try { await runTool(name, args); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  return <>
    {!backendAvailable && <div className="notice">{t("tools.backendNotice")}</div>}
    {error && <div className="errorbox" role="alert">{error}</div>}
    <div className="tools-actions-grid">
      <Section title={t("tools.currentTime")}>
        <p className="field-help">{t("tools.usesTimezone")}</p>
        <Button disabled={!!busy || !available("get_current_time")} onClick={() => void run("get_current_time", {})}>
          {busy === "get_current_time" ? t("tools.running") : t("tools.currentTime")}
        </Button>
      </Section>
      <Section title={t("tools.webSearch")}>
        <TextField label={t("tools.query")} value={query} onChange={setQuery} placeholder={t("tools.searchPlaceholder")} />
        <Button disabled={!!busy || !query.trim() || !available("web_search")} onClick={() => void run("web_search", { query: query.trim(), max_results: 3 })}>
          {busy === "web_search" ? t("tools.running") : t("tools.search")}
        </Button>
      </Section>
    </div>
    <section className="set-group">
      <div className="tools-catalog-toolbar">
        <div className="tools-catalog-heading"><h3>{t("tools.catalog")}</h3><span className="muted small" aria-live="polite">{visible.length} / {tools.length}</span></div>
        <label className="tools-catalog-search">
          <SearchIcon size={16} />
          <input className="field" type="search" aria-label={t("tools.filter")} placeholder={t("tools.filter")} value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>
      <div className="tools-catalog-grid">
        {visible.map((tool) => <article className="tools-catalog-item" key={tool.name}>
          <code>{tool.name}</code><p>{tool.description}</p>
        </article>)}
      </div>
      {!visible.length && <p className="field-help">{t("tools.noMatches")}</p>}
    </section>
    <section className="set-group">
      <div className="sec">{t("tools.recentRuns")}</div>
      {!runs.length && <p className="field-help">{t("tools.noRuns")}</p>}
      <div className="tools-runs">
        {[...runs].reverse().map((entry) => <details className="toolrun" key={entry.id}>
          <summary><code>{entry.name}</code><StatusBadge tone={entry.status === "ok" ? "positive" : entry.status === "error" ? "negative" : "warning"}>
            {t(entry.status === "ok" ? "tools.success" : entry.status === "error" ? "tools.failed" : "tools.running")}
          </StatusBadge></summary>
          <pre>{JSON.stringify(entry.result ?? entry.error, null, 2)}</pre>
        </details>)}
      </div>
    </section>
  </>;
}
