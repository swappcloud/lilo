// Collect submission outcomes without inspecting credentials or response bodies.
(() => {
  if (window.__liloPhoneObserver) return;
  const state = window.__liloPhoneObserver = {
    active: false, requests: 0, pending: 0, status: 0, failures: 0,
    submits: 0, invalid: 0, trustedInput: false,
  };
  const relevant = (method) => state.active && /^(POST|PUT|PATCH|DELETE)$/i.test(method);
  const begin = () => { state.requests++; state.pending++; };
  const end = (status) => {
    state.pending = Math.max(0, state.pending - 1); state.status = status;
    if (!status || status >= 400) state.failures++;
  };
  if (typeof window.fetch === 'function') {
    const fetch = window.fetch;
    window.fetch = function (...args) {
      const method = args[1]?.method || (typeof args[0] === 'object' && args[0]?.method) || 'GET';
      if (!relevant(method)) return fetch.apply(this, args);
      begin();
      try {
        return fetch.apply(this, args).then(response => { end(response.status); return response; },
          error => { end(0); throw error; });
      } catch (error) { end(0); throw error; }
    };
  }
  if (typeof XMLHttpRequest === 'function') {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const methods = new WeakMap();
    XMLHttpRequest.prototype.open = function (...args) {
      const result = open.apply(this, args); methods.set(this, args[0]); return result;
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (!relevant(methods.get(this) || 'GET')) return send.apply(this, args);
      begin(); let done = false;
      const finish = () => { if (!done) { done = true; end(this.status); } };
      this.addEventListener('loadend', finish, { once: true });
      try { return send.apply(this, args); } catch (error) { finish(); throw error; }
    };
  }
  document.addEventListener('submit', () => { if (state.active) state.submits++; }, true);
  document.addEventListener('invalid', () => { if (state.active) state.invalid++; }, true);
  document.addEventListener('input', event => {
    if (state.active) state.trustedInput = event.isTrusted;
  }, true);
})();
