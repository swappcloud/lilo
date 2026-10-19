import { createElement } from "react";
import type { PluginView } from "../../types";
import { installPluginProvider, removePluginProvider, providerDefinition, providerMeta, type ProviderMeta, type ProviderDefinition, type ProviderMarkProps } from "../contract";
import type { VoiceProvider } from "../types";
import { PluginVoiceTransport } from "./transport";

export function pluginProviderId(owner: string, local: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(owner) || !/^[a-zA-Z0-9_-]{1,64}$/.test(local)) throw new Error("Invalid plugin provider identity.");
  return `plugin:${owner}/${local}`;
}
function PluginMark({ size = 20, className }: ProviderMarkProps) {
  return createElement("svg", {width:size,height:size,className,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.5,"aria-hidden":true},
    createElement("path", {d:"M8 3v4m8-4v4M6 7h12v5a6 6 0 0 1-12 0V7zm6 11v3"}));
}
const installed = new Map<string, { fingerprint: string; instances: Set<VoiceProvider> }>();

/** Loaded declarations are the only authority; removal also releases active media. */
export function syncPluginProviders(plugins: PluginView[]): void {
  const desired = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.loaded || !plugin.enabled) continue;
    for (const spec of plugin.voiceProviders ?? []) {
      const id = pluginProviderId(plugin.manifest.id, spec.id);
      const base = spec.transport.kind === "host" ? providerDefinition(spec.transport.adapter) : undefined;
      if (spec.transport.kind === "host" && !base) continue;
      desired.add(id);
      const fingerprint = JSON.stringify([plugin.manifest.version, spec]);
      const previous = installed.get(id);
      if (previous?.fingerprint === fingerprint && providerDefinition(id)) continue;
      previous?.instances.forEach(instance => { void instance.disconnect(); });
      const instances = new Set<VoiceProvider>();
      const protocol = spec.protocol ?? {inbound:{userText:false,assistantText:false,nativeToolCalls:false,images:false},outbound:{text:false,stopSpeaking:false,systemPrompt:false,toolResult:false,image:false}};
      const definition: ProviderDefinition = {
        ...(base ?? {}), id, label:spec.label, shortLabel:spec.label, description:spec.description ?? "",
        icon: base?.icon ?? PluginMark, selectable:true, releaseStage:"beta",
        requiresAccount:base?.requiresAccount ?? !!spec.browser, accountProviderId:base?.accountProviderId ?? base?.id,
        capabilities:base ? {...base.capabilities, login:false,phoneLogin:false} : {voice:!!spec.settings?.some(field => field.key === "voice"),voiceMode:false,login:!!spec.browser,phoneLogin:!!spec.browser?.phoneForm,usage:true},
        protocol:base?.protocol ?? protocol, settings:base?.settings ?? (spec.settings ?? []).map(field => ({ key:field.key, kind:"select" as const, label:field.label, options:field.options })),
        optionDefaults:base?.optionDefaults ?? Object.fromEntries((spec.settings ?? []).map(field => [field.key, field.default])),
        normalizeOptions:base?.normalizeOptions ?? (options => Object.fromEntries((spec.settings ?? []).map(field => [field.key, field.options.some(option => option.value === options[field.key]) ? options[field.key] : field.default]))), login: !base && spec.browser ? { selectOnSuccess: true } : undefined,
        create: deps => {
          const transport = base ? base.create(deps) : new PluginVoiceTransport(plugin.manifest.id, spec, deps);
          const proxy = new Proxy(transport, { get(target, key) {
            if (key === "id") return id;
            if (key === "label") return spec.label;
            if (key === "connect") return async (...args: Parameters<VoiceProvider["connect"]>) => {
              instances.add(proxy);
              try { await target.connect(...args); } catch(error) {instances.delete(proxy);throw error;}
            };
            if (key === "disconnect") return async () => { instances.delete(proxy); await target.disconnect(); };
            const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
          }});
          instances.add(proxy); return proxy;
        },
      };
      installPluginProvider(definition); installed.set(id, {fingerprint,instances});
    }
  }
  for (const [id, entry] of installed) if (!desired.has(id)) {
    entry.instances.forEach(instance => { void instance.disconnect(); });
    removePluginProvider(id); installed.delete(id);
  }
}

/** A temporarily missing plugin must not silently change the selected account. */
export function retainPluginSelection(available: ProviderMeta[], selected: string): ProviderMeta[] {
  if (/^plugin:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_-]{1,64}$/.test(selected) && !available.some(meta => meta.id === selected)) {
    return [providerMeta(selected), ...available];
  }
  return available;
}
