(() => {
  if (window.top !== window.self || location.origin !== "https://grok.com") return;
  if (window.__liloGrokLogin) return;
  window.__liloGrokLogin = true;
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/rest/auth/get-user", { credentials: "include" });
      if (!response.ok) return;
      const data = await response.json();
      const user = data.user ?? data;
      if (!user || user.isAnonymous || user.isAnon || !(user.userId || user.id) || !user.email) return;
      clearInterval(timer);
      const parts = [user.givenName || user.firstName, user.familyName || user.lastName].filter(Boolean).join(" ");
      const profile = { name: String(user.name || user.fullName || user.displayName || parts || "").slice(0, 320),
        email: String(user.email || "").slice(0, 320) };
      const bytes = new TextEncoder().encode(JSON.stringify(profile));
      let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      location.href = "tauri-voice://grok-session#" + btoa(binary);
    } catch {
      // Login and challenge pages may temporarily refuse the account request.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(check, 1500);
  void check();
})();
