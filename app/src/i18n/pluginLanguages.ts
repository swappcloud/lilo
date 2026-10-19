import { create } from "zustand";
import { EN } from "./messages";
import type { PluginView } from "../types";

interface LanguageEntry {
  tag: string;
  name: string;
  owner: string;
  messages: Record<string, string>;
}

/** Host-owned language contributions. No preferences or plugin-store dependency. */
export const usePluginLanguages = create<{ entries: LanguageEntry[] }>(() => ({ entries: [] }));

export function canonicalLanguage(tag: string): string | null {
  if (typeof tag !== "string" || tag.length > 64) return null;
  try { return Intl.getCanonicalLocales(tag)[0]?.toLowerCase() ?? null; }
  catch { return null; }
}

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(",");
}

/** Only running, enabled plugins contribute; conflicting tags use the first id. */
export function installPluginLanguages(plugins: PluginView[]): void {
  const entries: LanguageEntry[] = [];
  const claimed = new Set<string>();
  for (const plugin of [...plugins].sort((a, b) => a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0)) {
    if (!plugin.enabled || !plugin.loaded) continue;
    for (const pack of (plugin.manifest.languages ?? []).slice(0, 16)) {
      const tag = canonicalLanguage(pack.tag);
      if (!tag || ["en", "pt", "it"].includes(tag.split("-")[0]) || claimed.has(tag)) continue;
      if (typeof pack.name !== "string" || !pack.name.trim() || pack.name.length > 120) continue;
      if (!pack.messages || typeof pack.messages !== "object" || Array.isArray(pack.messages)) continue;
      const messages: Record<string, string> = Object.create(null);
      let size = 0;
      for (const [key, value] of Object.entries(pack.messages).slice(0, 4096)) {
        if (!Object.hasOwn(EN, key) || typeof value !== "string" || value.length > 8000) continue;
        if (placeholders(value) !== placeholders(EN[key as keyof typeof EN])) continue;
        size += value.length;
        if (size > 256_000) break;
        messages[key] = value;
      }
      claimed.add(tag);
      entries.push({ tag: Intl.getCanonicalLocales(pack.tag)[0], name: pack.name, owner: plugin.manifest.id, messages });
    }
  }
  usePluginLanguages.setState({ entries });
}

export function pluginLanguage(tag: string): LanguageEntry | undefined {
  const normalized = canonicalLanguage(tag);
  if (!normalized) return undefined;
  const entries = usePluginLanguages.getState().entries;
  return entries.find((entry) => entry.tag.toLowerCase() === normalized)
    ?? entries.find((entry) => entry.tag.toLowerCase().split("-")[0] === normalized.split("-")[0]);
}

export function pluginDictionary(tag: string): Record<string, string> | undefined {
  return pluginLanguage(tag)?.messages;
}

export function pluginLanguages(): Array<Omit<LanguageEntry, "messages">> {
  return usePluginLanguages.getState().entries.map(({ tag, name, owner }) => ({ tag, name, owner }));
}
