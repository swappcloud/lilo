import { conversationForProvider, conversationProvider } from "./conversationScope";
import { activeQuota, useProviderLimits } from "./providerLimits";
import { create } from "zustand";
import { CaptionPersistence } from "./captionPersistence";

import {
  addAccount as ipcAddAccount,
  handleUtterance,
  onCommand,
  onCommandResult,
  onProviderLoginStatus,
  resetCommands,
  setAssistantName,
  setCommandLocales,
  getEnvInfo,
  getSettings,
  isTauri,
  hasHost,
  listAccounts,
  listTools,
  removeAccount as ipcRemoveAccount,
  runTool as ipcRunTool,
  setSettings,
  publishEvent,
} from "../lib/gateway";
import { applyOutcomes, type CommandHost } from "./commandEffects";
import {
  applyRustOptionMirrors,
  createProvider,
  defaultProviderId,
  isProviderId,
  normalizeProviderOptions,
  providerLogin,
  providerMeta,
  providerOptionDefaults,
  rustOptionMirror,
  type ProviderId,
} from "../providers";
import type { ProviderConversation, SharedImage, Unsubscribe, VoiceProvider } from "../providers";
import { log, logError } from "../lib/log";
import {
  effectiveGreeting,
  effectivePersona,
  usePreferencesStore,
} from "./preferencesStore";
import { replyLanguageDirective, resolveLanguage } from "./language";
import { openingPrompt } from "./sessionPrompt";
import { useConfirmStore } from "./confirmStore";
import { HiddenTurns } from "./hiddenTurns";
import { PendingNotes } from "./pendingNotes";
import { mergeConversationHistory } from "./conversationHistory";
import { ConversationEvents } from "./conversationEvents";
import { continuityContext, hasUserSpeech, spokenTurns } from "./conversationPolicy";
import { formatDuration } from "../shared/lib/format";
import { toast } from "./toastStore";
import { receiveGeneratedImage, useGeneratedImageStore } from "./generatedImages";
import { isOwnerWindow } from "../app/windowRole";
import { translate } from "../i18n";
import { translateIn } from "../i18n/translate";
import type {
  AccountView,
  AppSettings,
  ConnectionState,
  EnvInfo,
  ToolDescriptor,
  ToolRun,
  TranscriptTurn,
} from "../types";

const STORAGE_KEY = "lilo/state.v2";

/** Last ducking state pushed to the player, so we only act on a change. */
let duckedForSpeech = false;
/**
 * Persona/manifest turns we sent ourselves. Their echoes must never reach the
 * command router — the manifest names commands, so the router would run them.
 */
const hiddenTurns = new HiddenTurns();
/** Whether `text` is the echo of a turn LILO sent itself (persona, manifest). */
export const isHiddenTurn = (text: string): boolean => hiddenTurns.matches(text);
/** When the assistant last produced a caption, used to detect it went quiet. */
let lastAssistantCaptionAt = 0;
/** Ducking is released if the assistant has been silent this long. */
const DUCK_RELEASE_MS = 2_000;
/** Command events are app-wide; subscribe once for the process lifetime. */
let commandListenersReady = false;
let commandListenersPromise: Promise<void> | null = null;
/** "Running …" notes waiting to see whether their result beats them. */
const pendingNotes = new PendingNotes((text) =>
  useSessionStore.getState().sendText(text, { hidden: true }),
);
const MAX_TURNS = 2_000;
const MAX_CONVERSATIONS = 40;

/** Current-locale title for a fresh conversation. */
export function defaultConversationTitle(): string {
  return translate("conversations.newTitle");
}

export type LoginFlow = "idle" | "waiting" | "success" | "error";


export interface Conversation {
  id: string;
  /** One provider owns its context; switching providers selects another history. */
  providerId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: TranscriptTurn[];
  /**
   * Upstream conversation id per provider: an id only resumes on the backend
   * that issued it (Grok closes the socket on a foreign one).
   */
  sessions?: Record<string, string>;
  /** Durable provider threads and the last local turn each provider received. */
  threads?: Record<string, ProviderConversation>;
  providerLastTurn?: Record<string, string>;
  /** Context carried when a full conversation opens a successor. */
  continuationContext?: string;
  continuationOf?: string;
}

interface PersistedState {
  conversations: Conversation[];
  activeId: string;
  providerId: ProviderId;
  /** Per-provider settings: `{ "chatgpt-web": { voice, voiceMode }, … }`. */
  providerOptions: Record<string, Record<string, string>>;
  /** Legacy (v2): the single global voice, folded into the providers on load. */
  voice?: string;
  voiceMode?: string;
  /** Last reported voice budget per provider, and when it arrived. */
  voiceBudgets?: Record<string, VoiceBudget>;
  /** Legacy (v3): one budget, which only ChatGPT ever reported. */
  voiceBudgetSeconds?: number | null;
  voiceBudgetAt?: number | null;
  /**
   * Texts the app injected as the user (persona, language rule, greeting).
   * Kept so a conversation is never titled after the app's own words.
   */
  injectedTexts?: string[];
}

/** Collapse a text for comparison: case and spacing must not matter. */
function comparable(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

let injectedTexts = new Set<string>();

/** Texts the app itself sends as the user, now or in the current settings. */
function injectedNow(): string[] {
  const prefs = usePreferencesStore.getState();
  const language = prefs.language;
  return [
    effectiveGreeting(prefs),
    effectivePersona(prefs),
    replyLanguageDirective(language, resolveLanguage(language)),
  ];
}

function isInjectedText(text: string): boolean {
  const key = comparable(text);
  if (injectedTexts.has(key)) return true;
  return injectedNow().some((value) => comparable(value) === key);
}

/** Whether `timestamp` falls on the same local day as now. */
export interface VoiceBudget {
  /** Remaining seconds, as the backend reported them. */
  seconds: number;
  /** When the reading arrived; a daily quota from yesterday is not shown. */
  at: number;
}

/** The selected provider's remaining budget in seconds, if it reported one today. */
export function selectVoiceBudget(state: {
  providerId: string;
  voiceBudgets: Record<string, VoiceBudget>;
}): number | null {
  const budget = state.voiceBudgets[state.providerId];
  return budget && isToday(budget.at) ? budget.seconds : null;
}

function isToday(timestamp: number): boolean {
  const then = new Date(timestamp);
  const now = new Date();
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newConversation(index = 1, providerId?: string): Conversation {
  const now = Date.now();
  return {
    id: uid("conv"),
    ...(providerId ? { providerId } : {}),
    title:
      index <= 1
        ? defaultConversationTitle()
        : `${defaultConversationTitle()} ${index}`,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

/**
 * True for a title the app generated itself, in either language — so an
 * English-titled conversation is still recognised as untitled after the user
 * switches to Portuguese.
 */
function isDefaultTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith(translateIn("en", "conversations.newTitle")) ||
    trimmed.startsWith(translateIn("pt", "conversations.newTitle"))
  );
}

/** v3 stored a single budget, and only this backend ever reported one. */
const LEGACY_BUDGET_OWNER = "chatgpt-web";

function loadPersisted(): PersistedState {
  const fallback: PersistedState = {
    conversations: [newConversation()],
    activeId: "",
    providerId: defaultProviderId() ?? "",
    providerOptions: providerOptionDefaults(),
  };
  fallback.activeId = fallback.conversations[0].id;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const conversations =
      Array.isArray(parsed.conversations) && parsed.conversations.length > 0
        ? parsed.conversations
        : fallback.conversations;
    const activeId = conversations.some((c) => c.id === parsed.activeId)
      ? (parsed.activeId as string)
      : conversations[0].id;
    // v2 kept one global voice and voice mode: every provider that declares
    // those keys inherits them, then each owner repairs its own values.
    const legacy: Record<string, string> = {};
    if (typeof parsed.voice === "string") legacy.voice = parsed.voice;
    if (typeof parsed.voiceMode === "string") legacy.voiceMode = parsed.voiceMode;
    const stored: Record<string, Record<string, string>> = {};
    for (const [id, defaults] of Object.entries(providerOptionDefaults())) {
      const inherited = Object.fromEntries(
        Object.entries(legacy).filter(([key]) => key in defaults),
      );
      stored[id] = { ...inherited, ...(parsed.providerOptions?.[id] ?? {}) };
    }
    const providerOptions = normalizeProviderOptions(stored);

    const voiceBudgets: Record<string, VoiceBudget> = { ...(parsed.voiceBudgets ?? {}) };
    if (
      !voiceBudgets[LEGACY_BUDGET_OWNER] &&
      typeof parsed.voiceBudgetSeconds === "number" &&
      typeof parsed.voiceBudgetAt === "number"
    ) {
      voiceBudgets[LEGACY_BUDGET_OWNER] = {
        seconds: parsed.voiceBudgetSeconds,
        at: parsed.voiceBudgetAt,
      };
    }
    // A daily quota from another day says nothing about today.
    for (const [id, budget] of Object.entries(voiceBudgets)) {
      if (typeof budget?.seconds !== "number" || !isToday(budget.at)) {
        delete voiceBudgets[id];
      }
    }
    return {
      conversations,
      activeId,
      // A stored backend that is no longer installed must not be selected.
      providerId: isProviderId(parsed.providerId) ? parsed.providerId : fallback.providerId,
      providerOptions,
      voiceBudgets,
    };
  } catch {
    return fallback;
  }
}

function upsertTurn(
  turns: TranscriptTurn[],
  turn: TranscriptTurn,
): TranscriptTurn[] {
  const index = turns.findIndex((t) => t.id === turn.id);
  const next = index >= 0 ? turns.slice() : [...turns, turn];
  if (index >= 0) next[index] = turn;
  return next;
}

/** Turn a first message into a short conversation title. */
export function makeTitle(text: string): string {
  let title = text.trim().replace(/\s+/g, " ");
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  title = title.replace(/[.!?,;:]+$/g, "");
  title = title.replace(
    /^(hey|hi|hello|ok|okay|so|please|can you|could you|would you|i want to|i need|i'd like|help me|tell me|give me|show me)\b[\s,:-]*/i,
    "",
  );
  if (!title) title = text.trim();
  if (!title) return defaultConversationTitle();
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title.length > 44 ? `${title.slice(0, 44).trimEnd()}…` : title;
}

/** Whether `title` is an auto title cut from an earlier caption of `derived`. */
function titleGrewInto(title: string, derived: string): boolean {
  const stem = title.replace(/…$/, "").trim().toLowerCase();
  return stem.length > 0 && derived !== title && derived.toLowerCase().startsWith(stem);
}

/** What was really said in `conversation`, without what the app injected. */
export function spokenIn(conversation: Conversation) {
  return spokenTurns(conversation.turns, isInjectedText);
}

/** Drops every conversation the user never spoke in, except `keepId`. */
function withoutUnspoken(conversations: Conversation[], keepId: string): Conversation[] {
  return conversations.filter((c) => c.id === keepId || hasUserSpeech(spokenIn(c)));
}

export function deriveTitle(turns: TranscriptTurn[]): string | null {
  // Like ChatGPT: the title comes from the user's first real message. What the
  // app injects as the user (persona, language rule, greeting) is not a
  // message, and titling every session after the greeting was exactly that bug.
  const firstUser = turns.find(
    (t) => t.speaker === "user" && t.text.trim() && !isInjectedText(t.text),
  );
  if (!firstUser) return null;
  return makeTitle(firstUser.text);
}

function systemTurn(text: string): TranscriptTurn {
  return {
    id: uid("sys"),
    speaker: "system",
    text,
    final: true,
    timestamp: Date.now(),
  };
}

export interface SessionStore {
  // conversations
  conversations: Conversation[];
  activeId: string;

  // session config
  providerId: ProviderId;
  /** The active provider's own options, and every provider's stored ones. */
  providerOptions: Record<string, Record<string, string>>;
  muted: boolean;

  // live state
  connectionState: ConnectionState;
  /** Local voice-call identity shared with authorized plugins, never a vendor id. */
  pluginSessionId: string | null;
  connectionDetail?: string;
  assistantSpeaking: boolean;
  /**
   * Remaining voice budget each backend last reported. Budgets are per
   * account, so the chip shows the selected provider's, never another's.
   */
  voiceBudgets: Record<string, VoiceBudget>;
  micLevel: number;
  outputLevel: number;
  lastError?: string;

  // backend
  backendAvailable: boolean;
  settings: AppSettings | null;
  accounts: AccountView[];
  env: EnvInfo | null;
  tools: ToolDescriptor[];
  toolRuns: ToolRun[];

  // login
  loginStatus: LoginFlow;
  /** Which backend the current sign-in attempt belongs to. */
  loginProvider?: ProviderId;
  loginEmail?: string;
  loginMessage?: string;

  // actions
  newConversation: () => void;
  /**
   * Before a call: keep the active conversation unless it has grown long,
   * then start a fresh one.
   */
  continueConversation: () => void;
  rolloverConversation: () => Promise<void>;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  clearActiveTranscript: () => void;

  setProviderId: (id: ProviderId) => void;
  /** Store one option for one provider; the provider reads what it declared. */
  setProviderOption: (providerId: ProviderId, key: string, value: string) => void;
  toggleMute: () => void;
  applyBargeIn: (enabled: boolean, sensitivity: number) => void;
  applyInputDevice: (deviceId: string) => Promise<void>;
  applyOutputDevice: (deviceId: string) => Promise<void>;

  /**
   * Start a live session. `greeting` is sent as the first visible turn, after
   * the hidden opening (persona, command briefing, language rule), so the
   * model already knows its rules when it answers it.
   */
  connect: (options?: { greeting?: string }) => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (text: string, options?: { hidden?: boolean }) => void;
  submitPluginQuestion: (sessionId: string, prompt: string) => boolean;
  /** Show the live session a screenshot the host uploaded (vision). */
  relayImage: (image: SharedImage, text: string) => void;
  interrupt: () => void;
  endConversationByVoice: () => void;

  loadBackend: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  addAccount: (
    email: string,
    accessToken: string,
    deviceId?: string,
    proxy?: string,
  ) => Promise<void>;
  removeAccount: (provider: string, email: string) => Promise<void>;
  refreshTools: () => Promise<void>;
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;

  startLogin: (provider: ProviderId) => Promise<void>;
  cancelLogin: () => Promise<void>;
  /** Re-reads name/email from the signed-in-profile without wiping the session. */
  refreshProfile: (provider: ProviderId) => Promise<void>;
  initLoginListener: () => Promise<() => void>;
  /** Subscribe the app-wide router before local recognition dispatches. */
  initCommandRouting: () => Promise<void>;
}

let activeProvider: VoiceProvider | null = null;
let unsubscribers: Unsubscribe[] = [];
/**
 * Which connect attempt owns the session. A connect takes seconds, and the
 * wake word, the button and the keyboard shortcut can all start one: without
 * this, a slower attempt finished after a newer one and left two live
 * providers answering on top of each other. Every connect, disconnect or
 * teardown bumps it; an attempt that no longer matches drops what it built.
 */
let sessionGeneration = 0;
let loginListenerAttached = false;
/** Guards the voice hang-up from firing once per caption delta. */
let voiceEndInFlight = false;
/** When the live session actually connected; `null` while none is running. */
let sessionStartedAt: number | null = null;
let conversationEvents: ConversationEvents | null = null;

function clearSubscriptions(): void {
  unsubscribers.forEach((off) => off());
  unsubscribers = [];
}

/** Stop the active provider, whatever it is. Does not touch the generation. */
async function teardownActiveProvider(): Promise<void> {
  useSessionStore.setState({pluginSessionId: null});
  const events = conversationEvents;
  conversationEvents = null;
  clearSubscriptions();
  hiddenTurns.clear();
  pendingNotes.clear();
  const provider = activeProvider;
  activeProvider = null;
  await events?.close();
  if (provider) {
    try {
      await provider.disconnect();
    } catch {
      /* best effort */
    }
  }
}

const persisted = loadPersisted();
injectedTexts = new Set(persisted.injectedTexts ?? []);
// Titles written by earlier versions came from the injected greeting; re-derive
// them so an old history does not sit there all reading the same sentence.
for (const conversation of persisted.conversations) {
  const titleFromInjection =
    isDefaultTitle(conversation.title) ||
    injectedNow().some((text) => makeTitle(text) === conversation.title);
  const derived = deriveTitle(conversation.turns);
  if (titleFromInjection) {
    conversation.title = derived ?? defaultConversationTitle();
  } else if (derived && titleGrewInto(conversation.title, derived)) {
    // Earlier versions titled from the first partial caption and stopped.
    conversation.title = derived;
  }
}
persisted.conversations = withoutUnspoken(persisted.conversations, persisted.activeId);

export const useSessionStore = create<SessionStore>((set, get) => {
  const captionPersistence = new CaptionPersistence(() => {
    const s = get();
    const snapshot: PersistedState = {
      conversations: s.conversations.slice(0, MAX_CONVERSATIONS),
      activeId: s.activeId,
      providerId: s.providerId,
      providerOptions: s.providerOptions,
      voiceBudgets: s.voiceBudgets,
      // Bounded: only the last handful can matter for titling.
      injectedTexts: [...injectedTexts].slice(-20),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      /* storage may be unavailable */
    }
  });
  const persist = () => captionPersistence.flush();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", persist);
  }

  /**
   * Subscribe to the router once. These are app-wide Tauri events, not
   * per-connection provider callbacks, so they outlive a single call.
   */
  const ensureCommandListeners = (): Promise<void> => {
    if (commandListenersReady || !isTauri()) return Promise.resolve();
    if (commandListenersPromise) return commandListenersPromise;
    commandListenersPromise = (async () => {
      try {
      const prefs = usePreferencesStore.getState();
      await setAssistantName(prefs.wakePhrase);
      await setCommandLocales([]);
      await onCommand((outcomes) => {
        for (const outcome of outcomes) {
          log("command", `matched ${outcome.command}`);
          // The only hidden turn a match carries is its "running" note.
          applyOutcomes(
            { ...commandHost, sendHidden: (text) => pendingNotes.hold(outcome.command, text) },
            [outcome],
          );
        }
      });
      await onCommandResult(({ command, ok, summary, hiddenNote, followUp }) => {
        pendingNotes.settle(command);
        log("command", `${command} ${ok ? "ok" : "failed"}: ${summary}`);
        commandHost.systemTurn(summary);
        if (!ok) toast(summary);
        // Tell the model what actually happened so it narrates the result
        // instead of improvising one.
        if (get().connectionState === "connected") commandHost.sendHidden(hiddenNote);
        if (ok && followUp && get().connectionState === "connected") {
          // The router interrupted the provider before executing the plugin
          // command. Ask it to answer from the selected result now available
          // in the hidden turn. This keeps the lookup flow provider-neutral.
          get().sendText(
            "[LILO] Use the plugin data just retrieved to answer the user's latest request and continue the requested task. Do not claim the information is unavailable.",
          );
        }
      });
      commandListenersReady = true;
    } catch (error) {
      commandListenersReady = false;
      logError("command", error);
      throw error;
    } finally {
      commandListenersPromise = null;
    }
    })();
    return commandListenersPromise;
  };

  /**
   * The desktop half of the effect contract. The Rust router decides *what*
   * happened; this decides what that looks like here.
   */
  const commandHost: CommandHost = {
    interrupt: () => get().interrupt(),
    endCall: () => void get().endConversationByVoice(),
    isMuted: () => get().muted,
    toggleMute: () => get().toggleMute(),
    sendHidden: (text) => {
      if (get().connectionState === "connected") get().sendText(text, { hidden: true });
    },
    systemTurn: (text) => {
      patchActive((c) => ({
        ...c,
        turns: upsertTurn(c.turns, systemTurn(text)),
        updatedAt: Date.now(),
      }));
      persist();
    },
    toast: (text) => toast(text),
    confirm: (command) => useConfirmStore.getState().ask(command),
    clearConfirm: () => useConfirmStore.getState().clear(),
  };

  const patchActive = (fn: (c: Conversation) => Conversation) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === state.activeId ? fn(c) : c,
      ),
    }));
  };

  /**
   * Mirror a setting into the Rust `settings.json` so it survives a restart
   * (localStorage is only a fast cache).
   */
  const persistRustSettings = async (patch: Partial<AppSettings>) => {
    const current = get().settings;
    if (!hasHost() || !current) return;
    const next: AppSettings = { ...current, ...patch };
    try {
      await setSettings(next);
      set({ settings: next });
    } catch {
      /* keep the in-memory value even if the write failed */
    }
  };

  const switchConversation = (id: string) => {
    const state = get();
    if (state.connectionState === "connected" || state.connectionState === "connecting") {
      void state.disconnect();
    }
    const conversation = state.conversations.find((item) => item.id === id);
    const owner = conversation ? conversationProvider(conversation) : undefined;
    set({ activeId: id, ...(owner && isProviderId(owner) ? { providerId: owner } : {}) });
    if (owner && isProviderId(owner)) void persistRustSettings({ providerId: owner });
    persist();
  };

  return {
    conversations: persisted.conversations,
    activeId: persisted.activeId,
    providerId: persisted.providerId,
    providerOptions: persisted.providerOptions,
    muted: false,

      connectionState: "idle",
      pluginSessionId: null,
    assistantSpeaking: false,
    voiceBudgets: persisted.voiceBudgets ?? {},
    micLevel: 0,
    outputLevel: 0,

    backendAvailable: isTauri(),
    settings: null,
    accounts: [],
    env: null,
    tools: [],
    toolRuns: [],

    loginStatus: "idle",
    loginProvider: undefined,

    newConversation: () => {
      void resetCommands().catch(() => {});
      hiddenTurns.clear();
      const state = get();
      if (state.connectionState === "connected" || state.connectionState === "connecting") {
        void state.disconnect();
      }
      // An active conversation nobody spoke in is already a new one.
      const active = selectActiveConversation(state);
      if (active && !hasUserSpeech(spokenIn(active))) {
        set((s) => ({
          conversations: [
            { ...active, turns: [], sessions: undefined, threads: undefined, providerLastTurn: undefined, continuationContext: undefined, continuationOf: undefined, updatedAt: Date.now() },
            ...s.conversations.filter((c) => c.id !== active.id),
          ],
        }));
        persist();
        return;
      }
      const conversation = newConversation(state.conversations.length + 1, state.providerId);
      set((s) => ({
        conversations: [conversation, ...withoutUnspoken(s.conversations, "")],
        activeId: conversation.id,
      }));
      persist();
    },

    continueConversation: () => {
      // Never rolls over on its own: a fresh conversation means a fresh
      // upstream chat and a greeting, which the user only wants on request.
      const active = selectActiveConversation(get());
      if (!active) {
        get().newConversation();
        return;
      }
      // Back to the top of the list, where the newest call belongs.
      set((s) => ({
        conversations: [active, ...s.conversations.filter((c) => c.id !== active.id)],
      }));
      persist();
    },

    rolloverConversation: async () => {
      const state = get();
      const previous = selectActiveConversation(state);
      if (!previous) return;
      const generation = sessionGeneration;
      if (previous.continuationOf && !hasUserSpeech(spokenIn(previous))) {
        await state.disconnect();
        if (sessionGeneration === generation + 1 && get().activeId === previous.id && get().providerId === state.providerId) {
          set({ lastError: translate("conversation.continuationRejected") });
        }
        return;
      }
      const resume = state.connectionState === "connected";
      await state.disconnect();
      // A user selection, provider change or newer connection wins this race.
      if (sessionGeneration !== generation + 1 || get().activeId !== previous.id || get().providerId !== state.providerId) return;
      const next = newConversation(1, state.providerId);
      next.continuationOf = previous.id;
      next.continuationContext = conversationProvider(previous) === state.providerId ? continuityContext(spokenIn(previous), undefined, previous.continuationContext) ?? undefined : undefined;
      set((current) => ({ conversations: [next, ...current.conversations], activeId: next.id }));
      persist();
      if (resume) await get().connect();
    },

    selectConversation: (id) => switchConversation(id),

    deleteConversation: (id) => {
      const state = get();
      if (state.activeId === id && state.connectionState !== "idle") {
        void state.disconnect();
      }
      const remaining = state.conversations.filter((c) => c.id !== id);
      const conversations =
        remaining.length > 0 ? remaining : [newConversation(1)];
      const activeId =
        state.activeId === id ? conversations[0].id : state.activeId;
      set({ conversations, activeId });
      persist();
    },

    renameConversation: (id, title) => {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title: title.trim() || defaultConversationTitle() } : c,
        ),
      }));
      persist();
    },

    clearActiveTranscript: () => {
      patchActive((c) => ({ ...c, turns: [], updatedAt: Date.now() }));
      persist();
    },

    setProviderId: (id) => {
      const current = get();
      if (current.providerId === id) return;
      const resume = ["connected", "connecting", "reconnecting"].includes(current.connectionState);
      const generation = sessionGeneration;
      const stopped = current.connectionState !== "idle" ? current.disconnect() : Promise.resolve();
      const existing = conversationForProvider(current.conversations, current.activeId, id);
      const target = existing ? { ...existing, providerId: id } : newConversation(current.conversations.length + 1, id);
      const conversations = existing ? current.conversations.map((conversation) => conversation.id === target.id ? target : conversation)
        : [target, ...current.conversations].slice(0, MAX_CONVERSATIONS);
      set({ providerId: id, activeId: target.id, conversations, lastError: undefined });
      persist();
      void persistRustSettings({ providerId: id });
      if (resume) {
        void stopped.then(async () => {
          if (sessionGeneration !== generation + 1 || get().providerId !== id || get().activeId !== target.id) return;
          await get().connect();
        }).catch((error) => logError("provider-switch", error));
      }
    },

    setProviderOption: (providerId, key, value) => {
      set((s) => ({
        providerOptions: {
          ...s.providerOptions,
          [providerId]: { ...s.providerOptions[providerId], [key]: value },
        },
      }));
      persist();
      // Providers that mirror an option into the Rust settings own it there.
      const mirror = rustOptionMirror(providerId, key);
      if (mirror) {
        void persistRustSettings({
          [mirror.setting]: value,
        } as Partial<AppSettings>);
      }
    },

    toggleMute: () => {
      const next = !get().muted;
      set({ muted: next });
      activeProvider?.setMuted(next);
    },

    applyBargeIn: (enabled, sensitivity) => {
      activeProvider?.setBargeIn(enabled, sensitivity / 100);
    },

    applyInputDevice: async (deviceId) => {
      await activeProvider?.setInputDevice(deviceId);
    },

    applyOutputDevice: async (deviceId) => {
      await activeProvider?.setOutputDevice(deviceId);
    },

    connect: async (options) => {
      const generation = (sessionGeneration += 1);
      let state = get();
    const accountOwner = providerMeta(state.providerId).accountProviderId ?? state.providerId;
    const account = state.accounts.find((item) => item.provider === accountOwner)?.email ?? "";
    const quota = activeQuota(useProviderLimits.getState().reports[accountOwner], account);
    if (quota?.retryAt) {
      const message = translate("session.voiceLimitRetry", { backend: providerMeta(state.providerId).shortLabel, time: new Date(quota.retryAt).toLocaleString() });
      set({ lastError: message }); toast(message); return;
    }

      const existing = conversationForProvider(state.conversations, state.activeId, state.providerId);
    const target = existing ? { ...existing, providerId: state.providerId } : newConversation(state.conversations.length + 1, state.providerId);
    set({ activeId: target.id, conversations: existing ? state.conversations.map((conversation) => conversation.id === target.id ? target : conversation)
      : [target, ...state.conversations].slice(0, MAX_CONVERSATIONS) });
    state = get();
    await ensureCommandListeners();
      const active = state.conversations.find((c) => c.id === state.activeId);
      const { providerId } = state;
      const providerOptions = state.providerOptions[providerId] ?? {};
      const resolvedLanguage = resolveLanguage(
        usePreferencesStore.getState().language,
      );
      log(
        "session",
        `connect() provider=${providerId} options=${JSON.stringify(providerOptions)} ` +
          `pref=${usePreferencesStore.getState().language} language=${resolvedLanguage}`,
      );
      voiceEndInFlight = false;

      // Tear down whatever was running, without cancelling this attempt.
      await teardownActiveProvider();
      if (generation !== sessionGeneration) return;

      const provider = createProvider(providerId, {
        runTool: (name, args) => get().runTool(name, args),
      });
      activeProvider = provider;
      const pluginSessionId = uid("voice");
      set({pluginSessionId});
      const events = isTauri() ? new ConversationEvents(
        pluginSessionId, publishEvent, (text) => hiddenTurns.matches(text),
        (error) => logError("conversation-events", error),
      ) : null;
      conversationEvents = events;

      const subscriptions: Unsubscribe[] = [
        provider.onHistory?.((turns) => {
          if (activeProvider !== provider || generation !== sessionGeneration) return;
          patchActive((conversation) => ({ ...conversation, turns: mergeConversationHistory(conversation.turns, turns) }));
          persist();
        }) ?? (() => {}),
        provider.onConversation?.((thread) => {
          if (activeProvider !== provider || generation !== sessionGeneration) return;
          patchActive((conversation) => ({ ...conversation, threads: { ...conversation.threads, [providerId]: thread } }));
          persist();
        }) ?? (() => {}),
        provider.onConversationLimit?.(() => {
          if (activeProvider !== provider || generation !== sessionGeneration) return;
          void get().rolloverConversation().catch((error) => logError("conversation-rollover", error));
        }) ?? (() => {}),
        provider.onState((connectionState, connectionDetail) => {
          if (connectionState === "connected" && sessionStartedAt === null) {
            sessionStartedAt = Date.now();
          }
          set({ connectionState, connectionDetail });
        }),
        provider.onCaption((turn) => {
          if (activeProvider !== provider) return;
          // Subscribers evaluate speech freshness synchronously during set().
          if (turn.speaker === "assistant") lastAssistantCaptionAt = Date.now();
          events?.caption(turn);
          set((s) => {
            const conversations = s.conversations.map((c) => {
              if (c.id !== s.activeId) return c;
              const turns = upsertTurn(c.turns, turn);
              const providerLastTurn = turn.speaker !== "system" && !hiddenTurns.matches(turn.text) ? { ...c.providerLastTurn, [providerId]: turn.id } : c.providerLastTurn;
              // Still auto-titled (the title is what the turns so far gave):
              // follow the first caption as it grows; a rename is kept.
              const autoTitled = isDefaultTitle(c.title) || c.title === deriveTitle(c.turns);
              const title = autoTitled ? deriveTitle(turns) ?? c.title : c.title;
              return { ...c, turns, title, providerLastTurn, updatedAt: Date.now() };
            });
            return {
              conversations,
              assistantSpeaking:
                turn.speaker === "assistant"
                  ? !turn.final
                  : s.assistantSpeaking,
            };
          });
          captionPersistence.schedule();
          if (turn.final && turn.speaker !== "system" && (selectActiveConversation(get())?.turns.length ?? 0) >= MAX_TURNS) {
            void get().rolloverConversation().catch((error) => logError("conversation-rollover", error));
          }

          // Command detection: every caption goes to the Rust router, which
          // decides what is a command. Partial captions matter — the web path
          // often omits `final` — so the router debounces free-text slots
          // itself instead of the store guessing here.
          if (turn.speaker === "user" && isTauri() && !hiddenTurns.matches(turn.text)) {
            const route = async () => {
              if (turn.final) await events?.flush();
              if (activeProvider !== provider || generation !== sessionGeneration) return;
              await handleUtterance(turn.text, "user", turn.id, turn.final);
            };
            void route().catch(
              (error) => logError("command", error),
            );
          }
        }),
        provider.onLevel(({ mic, output }) => {
          const prev = get();
          if (
            Math.abs(prev.micLevel - mic) > 0.03 ||
            Math.abs(prev.outputLevel - output) > 0.03
          ) {
            set({ micLevel: mic, outputLevel: output });
          }
        }),
        provider.onQuota?.((quota) => {
        const owner = providerMeta(providerId).accountProviderId ?? providerId;
        const account = quota.accountKey ?? get().accounts.find((item) => item.provider === owner)?.email ?? "";
        useProviderLimits.getState().report(owner, account, quota);
      }) ?? (() => {}),
      provider.onUsage((seconds) => {
          set((s) => ({
            voiceBudgets: {
              ...s.voiceBudgets,
              [providerId]: { seconds, at: Date.now() },
            },
          }));
          log("session", `voice budget: ~${Math.round(seconds / 60)} min left`);
          persist();
        }),
        provider.onError((error) => {
          set((s) => {
            const conversations = s.conversations.map((c) =>
              c.id === s.activeId
                ? {
                    ...c,
                    turns: upsertTurn(c.turns, systemTurn(translate("session.error", { message: error.message }))),
                    updatedAt: Date.now(),
                  }
                : c,
            );
            return { lastError: error.message, conversations };
          });
          persist();
        }),
        provider.onImage?.((image) => receiveGeneratedImage(image, providerId)) ?? (() => {}),
        provider.onImageProgress?.((percent) => useGeneratedImageStore.getState().reportProgress(percent)) ?? (() => {}),
      ];
      unsubscribers = subscriptions;

      set({ lastError: undefined, muted: false });

      try {
        const prefs = usePreferencesStore.getState();
        const protocol = providerMeta(providerId).protocol;
        // Resume the durable thread and relay context this provider has not seen.
        const spoken = active ? spokenIn(active) : [];
        const recap = continuityContext(spoken, active?.threads?.[providerId] ? active.providerLastTurn?.[providerId] : undefined, active?.threads?.[providerId] ? undefined : active?.continuationContext);
        const continuing = spoken.length > 0 || !!active?.continuationContext;
        const prompt = await openingPrompt(protocol, recap);
        await provider.connect({
          // A backend that takes the prompt up front (Claude: the conversation's
          // first text turn) uses this; the rest get the hidden turns below.
          instructions: protocol.outbound.systemPrompt ? prompt.full : undefined,
          settings: providerOptions,
          // Drives the upstream transcriber. "auto" drifted to English and
          // returned truncated Portuguese, which matched no command.
          languageCode: resolveLanguage(prefs.language),
          sessionId: active?.sessions?.[providerId],
          conversation: active?.threads?.[providerId],
          micDeviceId: prefs.micDeviceId,
          speakerDeviceId: prefs.speakerDeviceId,
          bargeIn: prefs.bargeIn,
          bargeInSensitivity: prefs.bargeInSensitivity / 100,
        });
        if (generation !== sessionGeneration) {
          // A newer attempt (or a disconnect) took over while this one was
          // connecting: it must not answer, subscribe or greet anyone.
          subscriptions.forEach((off) => off());
          if (activeProvider === provider) activeProvider = null;
          await provider.disconnect().catch(() => {});
          log("session", "connect() superseded — dropped");
          return;
        }
        const sessionId = provider.getSessionId();
        if (sessionId) {
          patchActive((c) => ({
            ...c,
            sessions: { ...c.sessions, [providerId]: sessionId },
            updatedAt: Date.now(),
          }));
          persist();
        }
        log("session", "connect() ok");
        // Without a live text channel the prompt already went in with connect.
        if (!protocol.outbound.text) return;
        const opening = [prompt.persona, prompt.manifest, prompt.recap].filter(Boolean).join("\n\n");
        if (opening) {
          window.setTimeout(() => {
            if (activeProvider !== provider || get().connectionState !== "connected") return;
            get().sendText(opening, { hidden: true });
            const last = spoken.at(-1);
            if (last && recap) {
              patchActive((conversation) => ({ ...conversation, providerLastTurn: { ...conversation.providerLastTurn, [providerId]: last.id } }));
              persist();
            }
            log("session", "system prompt sent");
          }, 600);
        }
        // The reply-language rule goes as its own short turn, right before the
        // conversation starts. Inside the big persona block the model read it
        // as prose and kept answering Portuguese to an English speaker.
        window.setTimeout(() => {
          if (activeProvider !== provider || get().connectionState !== "connected") return;
          get().sendText(prompt.directive, { hidden: true });
          log("session", "language rule sent");
        }, 1100);
        // The greeting goes last, after the language rule, so the model
        // already knows which language to answer it in. Only a conversation
        // that has not started yet gets it: a continued one was greeted
        // already, and greeting it again makes the model answer "hi, I'm LILO"
        // on every wake.
        const greeting = continuing ? "" : options?.greeting?.trim();
        if (greeting) {
          window.setTimeout(() => {
            if (activeProvider !== provider || get().connectionState !== "connected") return;
            get().sendText(greeting, { hidden: true });
            log("session", "greeting sent");
          }, 1600);
        } else if (options?.greeting) {
          log("session", "greeting skipped — continuing the conversation");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("session", error);
        set({ lastError: message });
      }
    },

    disconnect: async () => {
      // Cancel a connect still in flight: it must not resurrect a session
      // after the user asked for it to stop.
      sessionGeneration += 1;
      const startedAt = sessionStartedAt;
      sessionStartedAt = null;
      await teardownActiveProvider();
      // How long the session ran is part of the conversation's record, and the
      // stage pill is gone the moment the call ends.
      if (startedAt !== null) {
        const seconds = (Date.now() - startedAt) / 1000;
        if (seconds >= 5) {
          const text = translate("session.duration", {
            label: formatDuration(seconds),
          });
          set((s) => ({
            conversations: s.conversations.map((conversation) =>
              conversation.id === s.activeId
                ? {
                    ...conversation,
                    turns: upsertTurn(conversation.turns, systemTurn(text)),
                    updatedAt: Date.now(),
                  }
                : conversation,
            ),
          }));
          persist();
        }
      }
      set({
        connectionState: "idle",
        connectionDetail: undefined,
        assistantSpeaking: false,
        micLevel: 0,
        outputLevel: 0,
        muted: false,
      });
    },

    sendText: (text, options) => {
      // Capability-gated: a voice-only backend has no text channel, so the
      // persona, language rule and greeting simply are not sent.
      if (!providerMeta(get().providerId).protocol.outbound.text) {
        // Routine for a voice-only backend: every tool/app command sends a
        // "hold on, the result is coming" hidden note first (see
        // router.rs::build_outcome) — surfacing that as a user-facing toast
        // fired on nearly every spoken command, not just real failures.
        log("session", "text not sent: the provider has no text channel");
        return;
      }
      if (options?.hidden) {
        hiddenTurns.remember(text);
        // Hidden turns are the app speaking as the user: remember them for the
        // titler, and make the store write so the memory survives a restart.
        injectedTexts.add(comparable(text));
        persist();
      }
      activeProvider?.sendText(text, options);
    },

    submitPluginQuestion: (sessionId, prompt) => {
      const state = get();
      if (!activeProvider || state.pluginSessionId !== sessionId || state.connectionState !== "connected" ||
          !isProviderId(state.providerId)) return false;
      const protocol = providerMeta(state.providerId).protocol;
      if (!protocol.outbound.text || !protocol.inbound.userText) return false;
      get().sendText("[LILO] Ask the user this question in its language. Do not answer it yourself or invent a user reply: " + prompt, {hidden:true});
      return true;
    },
    interrupt: () => activeProvider?.interrupt(),

    relayImage: (image, text) => {
      const state = get();
      if (state.connectionState !== "connected") return;
      if (!providerMeta(state.providerId).protocol.outbound.image || !activeProvider?.sendImage) {
        log("session", "the current backend cannot see images");
        toast(translate("session.noVision"));
        return;
      }
      activeProvider.sendImage(image, text);
    },

    endConversationByVoice: () => {
      const state = get();
      if (
        state.connectionState !== "connected" &&
        state.connectionState !== "connecting" &&
        state.connectionState !== "reconnecting"
      ) {
        return;
      }
      // The command can arrive as several caption deltas in one burst; only act
      // once per session.
      if (voiceEndInFlight) return;
      voiceEndInFlight = true;
      log("session", "voice stop command recognized — ending conversation");
      void resetCommands().catch(() => {});
      state.interrupt();
      toast(translate("session.ended"));
      void state.disconnect().catch((error) => logError("session", error));
    },

    loadBackend: async () => {
      set({ backendAvailable: isTauri() });
      if (!isTauri()) return;
      try {
        const [settings, accounts, env, tools] = await Promise.all([
          getSettings(),
          listAccounts(),
          getEnvInfo(),
          listTools(),
        ]);
        set({
          settings,
          accounts,
          env,
          tools,
          // Rust `settings.json` is the source of truth for persisted prefs;
          // localStorage is just a fast cache for the first paint.
          providerId: isProviderId(settings.providerId)
            ? settings.providerId
            : get().providerId,
          // The Rust settings remain the source of truth for the mirrored
          // provider options; fold them back into their owner.
          providerOptions: applyRustOptionMirrors(
            get().providerOptions,
            settings,
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ lastError: message });
      }
    },

    refreshAccounts: async () => {
      if (!isTauri()) return;
      try {
        set({ accounts: await listAccounts() });
      } catch {
        /* ignore */
      }
    },

    saveSettings: async (settings) => {
      if (hasHost()) {
        await setSettings(settings);
      }
      set({ settings });
    },

    addAccount: async (email, accessToken, deviceId, proxy) => {
      await ipcAddAccount(email, accessToken, deviceId, proxy);
      set({ accounts: await listAccounts() });
    },

    removeAccount: async (provider, email) => {
      const state = get();
      if ((providerMeta(state.providerId).accountProviderId ?? state.providerId) === provider) await state.disconnect();
      await ipcRemoveAccount(provider, email);
      set({ accounts: await listAccounts() });
    },

    refreshTools: async () => {
      if (!isTauri()) return;
      set({ tools: await listTools() });
    },

    runTool: async (name, args) => {
      const id = uid("tool");
      set((state) => ({
        toolRuns: [
          ...state.toolRuns,
          { id, name, args, status: "running", timestamp: Date.now() } as ToolRun,
        ].slice(-25),
      }));

      try {
        const result = await ipcRunTool(name, args);
        set((state) => ({
          toolRuns: state.toolRuns.map((r) =>
            r.id === id ? { ...r, status: "ok", result } : r,
          ),
        }));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          toolRuns: state.toolRuns.map((r) =>
            r.id === id ? { ...r, status: "error", error: message } : r,
          ),
        }));
        throw error;
      }
    },

    startLogin: async (provider) => {
      const flow = providerLogin(provider);
      if (!flow) {
        set({
          loginStatus: "error",
          loginMessage: `No sign-in flow is registered for ${provider}`,
        });
        return;
      }
      set({
        loginStatus: "waiting",
        loginProvider: provider,
        loginMessage: undefined,
      });
      try {
        await flow.login();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ loginStatus: "error", loginMessage: message });
      }
    },

    cancelLogin: async () => {
      const current = get().loginProvider;
      const flow = current ? providerLogin(current) : undefined;
      try {
        await flow?.cancel();
      } catch {
        /* best effort */
      }
      set({ loginStatus: "idle", loginMessage: undefined });
    },

    refreshProfile: async (provider) => {
      try {
        await providerLogin(provider)?.refresh();
      } catch (error) {
        logError("session", error);
      }
    },

    initCommandRouting: () => ensureCommandListeners(),
    initLoginListener: async () => {
      // React StrictMode mounts effects twice; keep exactly one listener.
      if (loginListenerAttached) return () => {};
      loginListenerAttached = true;

      const off = await onProviderLoginStatus((status) => {
        const flow = providerLogin(status.provider);
        if (!flow) return;
        const requestedLogin = get().loginStatus === "waiting"
          && get().loginProvider === status.provider;
        if (!requestedLogin) {
          void get().refreshAccounts();
          return;
        }
        if (status.status !== "ok") {
          set({ loginStatus: "error", loginMessage: status.message });
          void get().refreshAccounts();
          return;
        }
        set({ loginStatus: "success", loginEmail: status.email, loginMessage: undefined });
        if (flow.selectOnSuccess && requestedLogin) get().setProviderId(status.provider);
        void get().refreshAccounts();
      });
      return () => { loginListenerAttached = false; off(); };
    },
  };
});

export function selectActiveConversation(
  state: SessionStore,
): Conversation | undefined {
  return state.conversations.find((c) => c.id === state.activeId);
}
/**
 * Whether the assistant counts as talking: recent activity, not just the flag.
 *
 * `assistantSpeaking` only flips back on a caption marked final, and the web
 * path often omits that flag — which left the phase, the caption, LILO's face
 * *and* the music ducked on "speaking" for the rest of the session. Recent
 * assistant activity is the honest signal.
 */
export function assistantTalking(
  flags: { connectionState: string; assistantSpeaking: boolean },
  lastCaptionAt: number,
  now: number,
): boolean {
  return (
    flags.connectionState === "connected" &&
    flags.assistantSpeaking &&
    now - lastCaptionAt < DUCK_RELEASE_MS
  );
}

/**
 * Keep `assistantSpeaking` honest and the music ducked with it. A timer means
 * recovery does not depend on another event ever arriving.
 */
function syncTalking(): void {
  const state = useSessionStore.getState();
  const talking = assistantTalking(state, lastAssistantCaptionAt, Date.now());
  // The stale flag froze the phase on "speaking" after the assistant stopped.
  if (state.assistantSpeaking && !talking) {
    useSessionStore.setState({ assistantSpeaking: false });
  }

  if (talking === duckedForSpeech) return;
  duckedForSpeech = talking;
  void ipcRunTool("media_duck", { on: talking }).catch(() => {
    /* nothing playing, or media unavailable */
  });
}

// Ducking follows the owner's session; a panel only mirrors the flag.
if (typeof window !== "undefined" && isOwnerWindow()) {
  useSessionStore.subscribe(syncTalking);
  window.setInterval(syncTalking, 500);
}
