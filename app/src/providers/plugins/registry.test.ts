import { describe, expect, it } from "vitest";
import { pluginProviderId } from "./registry";

describe("plugin provider identities", () => {
  it("namespaces provider ids without allowing core impersonation", () => {
    expect(pluginProviderId("com.example.voice", "cloud")).toBe("plugin:com.example.voice/cloud");
    expect(() => pluginProviderId("com.example.voice", "../chatgpt-web")).toThrow();
    expect(() => pluginProviderId("../owner", "cloud")).toThrow();
  });
});

import { vi } from "vitest";
import { registerProvider, createProvider, providerMeta, providerDefinition, providerIds, normalizeProviderOptions, isProviderId, removePluginProvider } from "../contract";
import { syncPluginProviders } from "./registry";
import type { PluginView } from "../../types";
import type { VoiceProvider } from "../types";

const plugin: PluginView = {
  manifest: {id:"com.fixture.qwen",name:"Fixture",version:"1",api:1,capabilities:["provider:voice"]},
  loaded:true,enabled:true,manageable:true,tools:[],ui:{settings:[],status:[],actions:[]},
  voiceProviders:[{id:"web",label:"Fixture Qwen",transport:{kind:"host",adapter:"fixture-web"}}],
};
it("installs host adapters with canonical accounts and disconnects on removal", async () => {
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const native = {id:"fixture-web",disconnect} as unknown as VoiceProvider;
  registerProvider({id:"fixture-web",icon:()=>null,label:"Fixture",shortLabel:"Fixture",description:"",selectable:true,requiresAccount:true,
    capabilities:{voice:false,voiceMode:false,login:true,phoneLogin:true,usage:false},
    protocol:{inbound:{userText:true,assistantText:true,nativeToolCalls:false,images:false},outbound:{text:true,stopSpeaking:true,systemPrompt:true,toolResult:false,image:false}},
    settings:[],optionDefaults:{},create:()=>native});
  syncPluginProviders([plugin]);
  const id = pluginProviderId(plugin.manifest.id,"web");
  expect(providerMeta(id).accountProviderId).toBe("fixture-web");
  const adapter = createProvider(id);
  expect(adapter.id).toBe(id);
  expect(native.id).toBe("fixture-web");
  syncPluginProviders([]);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(providerIds()).not.toContain(id);
});
it("preserves a persisted plugin selection and options before plugins load", () => {
  const id = "plugin:com.fixture.pending/web";
  expect(isProviderId(id)).toBe(true);
  expect(providerMeta(id).selectable).toBe(false);
  expect(normalizeProviderOptions({[id]:{voice:"fixture"}})[id]).toEqual({voice:"fixture"});
  expect(() => createProvider(id)).toThrow(/unavailable/);
  removePluginProvider(id);
});

import { retainPluginSelection } from "./registry";
it("keeps an unavailable selected plugin in the picker instead of silently falling back", () => {
  const id="plugin:com.fixture.pending/web";
  expect(retainPluginSelection([],id).map(meta=>meta.id)).toEqual([id]);
  expect(retainPluginSelection([],"unknown-native")).toEqual([]);
});


it("renders plugin-owned choices and normalizes saved options without vendor branches", () => {
  const declaration: PluginView = {...plugin, voiceProviders:[{
    id:"custom",label:"Fixture voice",transport:{kind:"pcm"},
    settings:[{key:"voice",label:"Voice",default:"one",options:[{value:"one",label:"One"},{value:"two",label:"Two"}]}],
  }]};
  syncPluginProviders([declaration]);
  const id = pluginProviderId(plugin.manifest.id,"custom");
  expect(providerMeta(id).capabilities.voice).toBe(true);
  expect(providerDefinition(id)?.settings[0].label).toBe("Voice");
  expect(providerDefinition(id)?.normalizeOptions?.({voice:"two"})).toEqual({voice:"two"});
  expect(providerDefinition(id)?.normalizeOptions?.({voice:"missing"})).toEqual({voice:"one"});
  syncPluginProviders([]);
});

it("advertises phone login only when the installed plugin declares a real form", () => {
  const declaration: PluginView = {...plugin, voiceProviders:[{
    id:"phone",label:"Fixture phone",transport:{kind:"pcm"},
    browser:{loginUrl:"https://fixture.example/auth",homeUrl:"https://fixture.example/",allowedHosts:["fixture.example"],sessionProbe:"() => ({ready:false})",phoneForm:{entryText:"^log in$"}},
  }]};
  syncPluginProviders([declaration]);
  const id = pluginProviderId(plugin.manifest.id,"phone");
  expect(providerMeta(id).capabilities.phoneLogin).toBe(true);
  declaration.voiceProviders![0].browser!.phoneForm = null;
  syncPluginProviders([declaration]);
  expect(providerMeta(id).capabilities.phoneLogin).toBe(false);
  syncPluginProviders([]);
});
