(() => {
  if (location.origin !== "https://grok.com") return;
  const cfg = window.__liloGrokVoiceCfg;
  if (!cfg?.token || !window.__TAURI_INTERNALS__?.invoke) return;
  if (window.__liloGrokVoice?.token === cfg.token) return;
  window.__liloGrokVoice?.stop();
  let stopped = false;
  let ready = false;
  let socket;
  let pending = [];
  let reporting = Promise.resolve();
  const flush = () => {
    if (!pending.length || stopped) return;
    const events = pending;
    pending = [];
    // Serialize reports to preserve audio/frame ordering across IPC.
    reporting = reporting.then(() => window.__TAURI_INTERNALS__.invoke(
      "plugin:grok-voice|report", { token: cfg.token, events },
    )).catch(() => stop());
  };
  const report = (event) => {
    if (stopped) return;
    pending.push(event);
    if (pending.length >= 32) flush();
  };
  const send = (event, token = cfg.token) => {
    if (stopped || token !== cfg.token || socket?.readyState !== 1) return;
    socket.send(JSON.stringify({ timestamp: Date.now(), ...event }));
  };
  const timer = setInterval(flush, 20);
  const heartbeat = setInterval(() => send({ type: "ping" }), 10000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    pending = [];
    socket?.close(1000);
  };
  // A finished generated picture is fetched here, where the session's cookies
  // are, and crosses in parts that each fit one report batch.
  const PART = 256 * 1024;
  const fetched = new Set();
  const collectImage = async (attachment) => {
    let card;
    try { card = typeof attachment === "string" ? JSON.parse(attachment) : attachment; } catch { return; }
    const chunk = card?.image_chunk;
    if (card?.cardType !== "generated_image_card" || !chunk || chunk.progress < 100 || chunk.moderated) return;
    const id = String(chunk.imageUuid || card.id || "");
    if (!id || typeof chunk.imageUrl !== "string" || fetched.has(id)) return;
    fetched.add(id);
    try {
      const response = await fetch(new URL(chunk.imageUrl, "https://assets.grok.com/"), { credentials: "include" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024) throw new Error("image too large");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(new Error("unreadable image"));
        reader.readAsDataURL(blob);
      });
      const parts = Math.max(1, Math.ceil(data.length / PART));
      const meta = {
        type: "image", id, parts, mime: blob.type || "image/jpeg",
        prompt: String(chunk.imagePrompt?.prompt || card.query || "").slice(0, 500),
        width: chunk.resolution?.width, height: chunk.resolution?.height,
      };
      flush();
      for (let part = 0; part < parts; part++) {
        report({ ...meta, part, data: data.slice(part * PART, (part + 1) * PART) });
        flush();
      }
    } catch (error) {
      report({ type: "image-error", id, reason: String(error?.message || error).slice(0, 200) });
    }
  };
  window.__liloGrokVoice = { token: cfg.token, send, stop };
  const url = new URL("/ws/app_chat/stream_audio", "wss://grok.com");
  url.searchParams.set("model", "xai");
  url.searchParams.set("client", "oai");
  url.searchParams.set("client_name", "web");
  url.searchParams.set("enable_search", "true");
  url.searchParams.set("voice", cfg.voice || "ara");
  if (cfg.language) url.searchParams.set("x-app-language", cfg.language);
  if (cfg.conversationId) url.searchParams.set("conversation_id", cfg.conversationId);
  try {
    socket = new WebSocket(url.toString());
    socket.binaryType = "arraybuffer";
    socket.onopen = () => send({
      type: "session.update",
      session: {
        voice: cfg.voice || "ara", playback_speed: 1,
        enable_vision: false, keep_context: Boolean(cfg.conversationId),
        turn_detection: { type: "server_vad" },
        ...(cfg.instructions ? { instructions: cfg.instructions, is_raw_instructions: true } : {}),
      },
    });
    socket.onmessage = ({ data }) => {
      if (stopped) return;
      try {
        const frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
        if (!frame || typeof frame.type !== "string") return;
        if (frame.type === "ping") { send({ type: "pong", ping_timestamp: frame.ping_timestamp || Date.now() }); return; }
        if (frame.type === "pong") return;
        if (frame.type === "error") {
          const code = frame.error?.code;
          const messages = {
            concurrency_limit: "Grok already has an active voice session. End voice calls in the Grok website or app, then try again in LILO.",
            rate_limit_exceeded: "Grok is limiting voice requests for this signed-in account. Wait before trying again and check voice access in Grok with the same account.",
            usage_pool_exhausted: "This signed-in Grok account has exhausted its voice allowance. Check voice access in Grok with the same account.",
            usage_limit_reached: "This signed-in Grok account has reached its voice allowance. Check voice access in Grok with the same account.",
          };
          const known = Object.hasOwn(messages, code);
          report({ type: "error", reason: known ? code : "voice_request_rejected", message: known
            ? messages[code]
            : "Grok refused the voice request. Check your account's voice access." });
          flush();
          stop();
          return;
        }
        if (frame.type === "response.grok.output" && frame.card_attachment) void collectImage(frame.card_attachment);
        if (frame.type === "conversation.created" && typeof frame.conversation?.id === "string" && !ready) {
          ready = true;
          report({ type: "ready", conversationId: frame.conversation.id });
        }
        report({ type: "frame", message: frame });
      } catch {
        report({ type: "error", message: "Grok sent an unsupported voice frame." });
      }
    };
    socket.onerror = () => report({ type: "error", message: "Could not connect to Grok voice. Open Grok sign-in and check your account." });
    socket.onclose = ({ code, reason }) => {
      if (stopped) return;
      report({ type: "closed", code, reason: String(reason || "").slice(0, 200) });
      if (!ready) report({ type: "error", message: "Grok closed the connection before voice became ready." });
      flush();
      clearInterval(timer);
      clearInterval(heartbeat);
    };
  } catch {
    report({ type: "error", message: "The Grok voice socket could not be created." });
    flush();
  }
})();
