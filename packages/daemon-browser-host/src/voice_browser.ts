import { parseInbound } from "../../../app/src/providers/chatgpt/events";
import { advanceCaption } from "../../../app/src/providers/chatgpt/captionStream";
import type { TranscriptTurn } from "../../../app/src/types";
import { buildRelayMessage, buildStopSpeaking } from "../../../app/src/providers/chatgpt/dcProtocol";

type VoiceEvent = { sequence: number; speaker: "user" | "assistant"; text: string; final: boolean; turnId?: string };
type VoiceOptions = { voice?: string; voiceMode?: string; languageCode?: string; prompt?: string; directive?: string };

declare global {
  interface Window { __liloVoice?: ReturnType<typeof createVoice>; __liloDeviceId?: string }
}

const voices = new Set(["breeze", "cove", "ember", "fathom", "glimmer", "juniper", "maple", "orbit", "vale"]);
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;
const OPENING_CONTEXT_DELAY_MS = 600;
const OPENING_DIRECTIVE_DELAY_MS = 500;

function createVoice() {
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let mic: MediaStream | null = null;
  let sender: RTCRtpSender | null = null;
  let muted = false;
  let state: "idle" | "starting" | "connected" | "error" = "idle";
  let sessionId: string | undefined;
  let sequence = 0;
  let stage = "browser";
  let diagnostic: { stage: string; category: string; status?: number } | null = null;
  let audioPlayError: string | null = null;
  let sentMessages = 0;
  let receivedMessages = 0;
  let remoteAudio: HTMLAudioElement | null = null;
  const events: VoiceEvent[] = [];
  const hiddenTexts = new Set<string>();
  const hiddenMessageIds = new Set<string>();
  let partial: TranscriptTurn | null = null;

  function append(speaker: "user" | "assistant", text: string, final: boolean, turnId?: string, mode: "replace" | "append" = "replace") {
    if (!text.trim()) return;
    const prior = events.at(-1);
    if (prior && prior.speaker === speaker && prior.turnId === turnId && (!prior.final || final)) {
      prior.sequence = ++sequence;
      prior.text = (mode === "append" ? prior.text + text : text).slice(0, 4000);
      prior.final = final;
      return;
    }
    events.push({ sequence: ++sequence, speaker, text: utf8Prefix(text, 4096), final, ...(turnId ? { turnId } : {}) });
    if (events.length > 100) events.splice(0, events.length - 100);
  }

  function attachAudio(stream: MediaStream) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = stream;
    audio.dataset.liloVoice = "remote";
    document.body.append(audio);
    remoteAudio = audio;
    void audio.play().catch(error => {
      const name = (error as { name?: string } | null)?.name;
      audioPlayError = ["NotAllowedError", "NotSupportedError", "AbortError"].includes(name ?? "") ? name! : "Other";
    });
  }

  function registerHidden(id: string, text: string) {
    hiddenMessageIds.add(id);
    hiddenTexts.add(text.trim().toLowerCase().replace(/\s+/g, " "));
    while (hiddenMessageIds.size > 128) hiddenMessageIds.delete(hiddenMessageIds.values().next().value!);
    while (hiddenTexts.size > 128) hiddenTexts.delete(hiddenTexts.values().next().value!);
  }

  async function acquireMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    mic = stream;
    if (sender) await sender.replaceTrack(stream.getAudioTracks()[0] ?? null);
    return stream;
  }

  function sessionPayload(options: VoiceOptions, id: string) {
    const voice = options.voice?.trim().toLowerCase() ?? "cove";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return {
      backend_reasoning_effort: "instant",
      language_code: options.languageCode?.trim() || "auto",
      requested_default_model: "",
      voice: voices.has(voice) ? voice : "cove",
      voice_session_id: id,
      voice_status_request_id: id,
      timezone_offset_min: -new Date().getTimezoneOffset(),
      timezone,
      voice_mode: ["standard", "advanced", "wingman"].includes(options.voiceMode ?? "") ? options.voiceMode : "wingman",
      model_slug: "",
      model_slug_advanced: "",
      client_tools: [],
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      enable_message_streaming: true,
    };
  }

  async function start(options: VoiceOptions) {
    if (state === "connected" || state === "starting") return snapshot();
    state = "starting";
    const id = crypto.randomUUID().toUpperCase();
    sessionId = id;
    try {
      stage = "microphone";
      const stream = await acquireMic();
      stage = "offer";
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun4.l.google.com:19302" }],
        bundlePolicy: "max-bundle",
      });
      pc = peer;
      sender = peer.addTrack(stream.getAudioTracks()[0], stream);
      const dc = peer.createDataChannel("oai-events", { negotiated: true, id: 0 });
      channel = dc;
      let resolveChannelReady!: () => void;
      let rejectChannelReady!: (error: Error) => void;
      let channelReadySettled = false;
      let channelTimer: ReturnType<typeof setTimeout> | undefined;
      const channelReady = new Promise<void>((resolve, reject) => {
        resolveChannelReady = resolve;
        rejectChannelReady = reject;
      });
      void channelReady.catch(() => {});
      const finishChannelReady = (error?: Error) => {
        if (channelReadySettled) return;
        channelReadySettled = true;
        if (channelTimer) clearTimeout(channelTimer);
        if (error) rejectChannelReady(error);
        else resolveChannelReady();
      };
      dc.onmessage = event => {
        receivedMessages++;
        for (const parsed of parseInbound(typeof event.data === "string" ? event.data : "")) {
          if (parsed.kind === "stopped" && partial?.speaker === "assistant") {
            append(partial.speaker, partial.text, true, partial.id);
            partial = null;
          }
          if ((parsed.kind === "caption" || parsed.kind === "message") && (parsed.speaker === "user" || parsed.speaker === "assistant")) {
            if (parsed.speaker === "user" && ((parsed.messageId && hiddenMessageIds.delete(parsed.messageId)) || hiddenTexts.delete(parsed.text.trim().toLowerCase().replace(/\s+/g, " ")))) continue;
            const next = advanceCaption(partial, parsed);
            if (next.finalized) append(next.finalized.speaker as "user" | "assistant", next.finalized.text, true, next.finalized.id);
            append(next.turn.speaker as "user" | "assistant", next.turn.text, next.turn.final, next.turn.id);
            partial = next.partial;
          }
        }
      };
      dc.onopen = () => {
        const prompt = options.prompt?.trim();
        const directive = options.directive?.trim();
        const sendHidden = (text: string) => {
          const id = `lilo-context-${crypto.randomUUID()}`;
          if (!sendMessage(buildRelayMessage(text, { id }))) return false;
          registerHidden(id, text);
          return true;
        };
        const sendDirective = () => {
          if (channelReadySettled) return;
          try {
            if (directive && !sendHidden(directive)) {
              finishChannelReady(voiceFailure("connected", "connection-lost"));
              return;
            }
            finishChannelReady();
          } catch {
            finishChannelReady(voiceFailure("connected", "connection-lost"));
          }
        };
        if (prompt) {
          setTimeout(() => {
            if (channelReadySettled) return;
            try {
              if (!sendHidden(prompt)) {
                finishChannelReady(voiceFailure("connected", "connection-lost"));
                return;
              }
              if (directive) setTimeout(sendDirective, OPENING_DIRECTIVE_DELAY_MS);
              else finishChannelReady();
            } catch {
              finishChannelReady(voiceFailure("connected", "connection-lost"));
            }
          }, OPENING_CONTEXT_DELAY_MS);
          return;
        }
        if (directive) setTimeout(sendDirective, OPENING_CONTEXT_DELAY_MS);
        else finishChannelReady();
      };
      dc.onclose = () => finishChannelReady(voiceFailure("connected", "connection-lost"));
      dc.onerror = () => finishChannelReady(voiceFailure("connected", "connection-lost"));
      peer.ontrack = event => attachAudio(event.streams[0] ?? new MediaStream([event.track]));
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          state = "error";
          diagnostic = { stage: "connected", category: "connection-lost" };
        }
      };
      stage = "offer";
      const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await peer.setLocalDescription(offer);
      stage = "ice";
      await new Promise<void>(resolve => {
        if (peer.iceGatheringState === "complete") return resolve();
        const onChange = () => {
          if (peer.iceGatheringState === "complete") { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", onChange); resolve(); }
        };
        const timer = setTimeout(() => { peer.removeEventListener("icegatheringstatechange", onChange); resolve(); }, 2500);
        peer.addEventListener("icegatheringstatechange", onChange);
      });
      const session = JSON.stringify(sessionPayload(options, id));
      const form = new FormData();
      form.append("sdp", peer.localDescription?.sdp ?? offer.sdp ?? "");
      form.append("session", session);
      stage = "session";
      let auth: Response;
      let authData: Record<string, unknown>;
      try {
        auth = await fetch("/api/auth/session", { credentials: "include", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
        if (!auth.ok) throw voiceFailure("session", "provider-response", auth.status);
        authData = await auth.json() as Record<string, unknown>;
      } catch (error) { throw classifyFailure(error, "session"); }
      if (typeof authData.accessToken !== "string" || !authData.accessToken) throw voiceFailure("session", "expired-session");
      stage = "provider-answer";
      let response: Response;
      try {
        response = await fetch("/realtime/wm?dcid=0", {
          method: "POST",
          credentials: "include",
          headers: { authorization: `Bearer ${authData.accessToken}`, ...(window.__liloDeviceId ? { "oai-device-id": window.__liloDeviceId } : {}) },
          body: form,
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) { throw classifyFailure(error, "provider-answer"); }
      const answer = await response.text();
      if (!response.ok) throw voiceFailure("provider-answer", "provider-response", response.status);
      if (!answer.trimStart().startsWith("v=0")) throw voiceFailure("provider-answer", "invalid-answer");
      const answerSdp = answer.trim().replace(/\r\n|\r|\n/g, "\r\n") + "\r\n";
      try { await peer.setRemoteDescription({ type: "answer", sdp: answerSdp }); }
      catch { throw voiceFailure("provider-answer", "invalid-answer"); }
      stage = "connected";
      if (!channelReadySettled) {
        channelTimer = setTimeout(() => {
          finishChannelReady(voiceFailure("connected", "timeout"));
        }, CHANNEL_OPEN_TIMEOUT_MS);
      }
      await channelReady;
      state = "connected";
      return snapshot();
    } catch (error) {
      diagnostic = diagnosticFrom(error, stage);
      state = "error";
      await stop();
      state = "error";
      throw new Error(`LILO_VOICE|${diagnostic.stage}|${diagnostic.category}${diagnostic.status ? `|${diagnostic.status}` : ""}`);
    }
  }

  async function stop() {
    partial = null;
    channel?.close(); channel = null;
    pc?.close(); pc = null; sender = null;
    mic?.getTracks().forEach(track => track.stop()); mic = null;
      document.querySelectorAll<HTMLAudioElement>('audio[data-lilo-voice="remote"]').forEach(audio => { audio.pause(); audio.srcObject = null; audio.remove(); });
    remoteAudio = null;
    muted = false;
    sessionId = undefined;
    state = "idle";
    return snapshot();
  }

  async function setMuted(value: boolean) {
    if (!pc || state !== "connected") throw new Error("Voice session is not connected.");
    if (value === muted) return snapshot();
    if (value) {
      await sender?.replaceTrack(null);
      mic?.getTracks().forEach(track => track.stop());
      mic = null;
      muted = true;
    } else {
      await acquireMic();
      muted = false;
    }
    return snapshot();
  }

  function sendMessage(message: string) {
    if (channel?.readyState !== "open") return false;
    channel.send(message);
    sentMessages++;
    return true;
  }
  function interrupt() { sendMessage(buildStopSpeaking()); return snapshot(); }
  function text(value: string, hidden = false) {
    if (!value.trim() || value.length > (hidden ? 16000 : 4000) || channel?.readyState !== "open") throw new Error("Voice channel is unavailable.");
    if (hidden) {
      const id = `lilo-context-${crypto.randomUUID()}`;
      registerHidden(id, value);
      sendMessage(buildRelayMessage(value, { id }));
    } else sendMessage(buildRelayMessage(value));
    return snapshot();
  }
  async function transportDiagnostics() {
    const stats = await pc?.getStats().catch(() => null);
    const result = {
      connectionState: pc?.connectionState ?? "closed",
      iceConnectionState: pc?.iceConnectionState ?? "closed",
      iceGatheringState: pc?.iceGatheringState ?? "complete",
      dataChannelState: channel?.readyState ?? "closed",
      sentMessages,
      receivedMessages,
      inboundAudio: { packets: 0, bytes: 0, audioLevel: null as number | null, totalAudioEnergy: null as number | null },
      outboundAudio: { packets: 0, bytes: 0, audioLevel: null as number | null, totalAudioEnergy: null as number | null },
      microphone: { audioLevel: null as number | null, totalAudioEnergy: null as number | null },
      remoteAudio: { attached: Boolean(remoteAudio), paused: remoteAudio?.paused ?? true, readyState: remoteAudio?.readyState ?? 0, playError: audioPlayError },
    };
    if (stats) for (const report of stats.values()) {
      const row = report as Record<string, unknown>;
      if (row.kind !== "audio" && row.mediaType !== "audio") continue;
      if (row.type === "inbound-rtp") {
        result.inboundAudio.packets += finiteCounter(row.packetsReceived);
        result.inboundAudio.bytes += finiteCounter(row.bytesReceived);
        result.inboundAudio.audioLevel = finiteMetric(row.audioLevel) ?? result.inboundAudio.audioLevel;
        result.inboundAudio.totalAudioEnergy = finiteMetric(row.totalAudioEnergy) ?? result.inboundAudio.totalAudioEnergy;
      } else if (row.type === "outbound-rtp") {
        result.outboundAudio.packets += finiteCounter(row.packetsSent);
        result.outboundAudio.bytes += finiteCounter(row.bytesSent);
        result.outboundAudio.audioLevel = finiteMetric(row.audioLevel) ?? result.outboundAudio.audioLevel;
        result.outboundAudio.totalAudioEnergy = finiteMetric(row.totalAudioEnergy) ?? result.outboundAudio.totalAudioEnergy;
      } else if (row.type === "media-source") {
        result.microphone.audioLevel = finiteMetric(row.audioLevel) ?? result.microphone.audioLevel;
        result.microphone.totalAudioEnergy = finiteMetric(row.totalAudioEnergy) ?? result.microphone.totalAudioEnergy;
      }
    }
    return result;
  }
  function snapshot(after = 0) { return { state, muted, ...(sessionId ? { sessionId } : {}), events: events.filter(event => event.sequence > after).map(event => ({ ...event })) }; }
  function getDiagnostic() { return diagnostic ? { ...diagnostic } : null; }
  return { start, stop, setMuted, interrupt, text, snapshot, diagnostics: getDiagnostic, transportDiagnostics };
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function voiceFailure(stage: string, category: string, status?: number): Error & { voiceDiagnostic: { stage: string; category: string; status?: number } } {
  const error = new Error("Voice transport failed.") as Error & { voiceDiagnostic: { stage: string; category: string; status?: number } };
  error.voiceDiagnostic = { stage, category, ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) };
  return error;
}

function classifyFailure(error: unknown, stage: string) {
  const named = error as { name?: string; voiceDiagnostic?: { stage: string; category: string; status?: number } } | null;
  if (named?.voiceDiagnostic) return voiceFailure(named.voiceDiagnostic.stage, named.voiceDiagnostic.category, named.voiceDiagnostic.status);
  const name = named?.name ?? "";
  if (stage === "microphone") {
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) return voiceFailure(stage, "audio-permission");
    if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(name)) return voiceFailure(stage, "audio-device-missing");
  }
  if (name === "TimeoutError" || name === "AbortError") return voiceFailure(stage, "timeout");
  if (stage === "provider-answer" || stage === "session") return voiceFailure(stage, "network");
  if (stage === "offer") return voiceFailure(stage, "offer-failed");
  return voiceFailure(stage, "browser-failure");
}

function diagnosticFrom(error: unknown, stage: string) {
  const named = error as { voiceDiagnostic?: { stage: string; category: string; status?: number }; message?: string; name?: string } | null;
  if (named?.voiceDiagnostic) return named.voiceDiagnostic;
  const code = typeof named?.message === "string" ? named.message.match(/LILO_VOICE\|(browser|session|microphone|offer|ice|provider-answer|connected)\|([a-z-]+)(?:\|(\d{3}))?/) : null;
  if (code) return { stage: code[1], category: code[2], ...(code[3] ? { status: Number(code[3]) } : {}) };
  return classifyFailure(error, stage).voiceDiagnostic;
}

function utf8Prefix(value: string, limit: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > limit) break;
    bytes += size;
    result += character;
  }
  return result;
}

window.__liloVoice ??= createVoice();
window.__liloVoice;
