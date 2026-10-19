/** Vendor-owned URLs and session decoding; the browser host owns interaction. */
export const chatgpt = {
  id: "chatgpt-web",
  voice: true,
  loginUrl: "https://chatgpt.com/auth/login",
  homeUrl: "https://chatgpt.com/",
  phoneForm: {
    entry: 'button[data-testid="login-button"]', entryText: "",
    codeSwitch: "one-time code|c[oó]digo|codice", codeInputs: "",
    phoneSwitch: "continue with phone|continuar com (telefone|celular)|continua con (il )?(telefono|cellulare)",
  },
  navigationHosts: ["chatgpt.com", "auth.openai.com", "auth0.openai.com", "accounts.google.com", "appleid.apple.com"],
  responseCategory(url, method) {
    const parsed = new URL(url);
    if (method === "GET" && parsed.hostname === "chatgpt.com" && parsed.pathname === "/api/auth/session") return "session";
    if (method === "POST" && parsed.hostname === "chatgpt.com" && parsed.pathname === "/realtime/wm") return "voice";
    if (method !== "POST") return null;
    if (parsed.hostname === "auth.openai.com" && parsed.pathname.includes("password")) return "password";
    if (parsed.hostname === "auth.openai.com" && parsed.pathname.startsWith("/api/accounts/")) return "auth";
    if (parsed.hostname === "sentinel.openai.com") return "sentinel";
    return null;
  },
  capture: {
    origin: "https://chatgpt.com",
    cookiePattern: String.raw`(__Secure-)?(next-auth|authjs)\.session-token(?:\.\d+)?`,
    script: `(()=>{if(!window.__liloSessionPending && Date.now()-(window.__liloSessionChecked||0)>5000){window.__liloSessionPending=true;window.__liloSessionChecked=Date.now();fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).then(s=>window.__liloPrivateSession=s).catch(()=>{}).finally(()=>window.__liloSessionPending=false)}return JSON.stringify(window.__liloPrivateSession||null)})()`,
  },
};
