
(() => {
  // Session clearing starts on about:blank. Wait for the provider document
  // before probing controls or emitting callbacks from that temporary page.
  if (!location.host) return;
  const field = __FIELD__;
  const value = __VALUE__;
  const attempt = __ATTEMPT__;
  window.__liloPhoneAttempt = attempt;
  const observation = window.__liloPhoneObserver;
  if (observation) observation.active = true;
  const entry = __ENTRY__;
  const entryText = __ENTRY_TEXT__;
  const entryPattern = entryText ? new RegExp(entryText, 'i') : null;
  const codeSwitch = __CODE_SWITCH__ ? new RegExp(__CODE_SWITCH__, 'i') : null;
  const phoneSwitch = __PHONE_SWITCH__ ? new RegExp(__PHONE_SWITCH__, 'i') : null;
  const codeInputsSelector = __CODE_INPUTS__;
  const codeInputs = () => codeInputsSelector
    ? [...document.querySelectorAll(codeInputsSelector)].filter(visible)
    : [];

  const report = (obj) => {
    if (typeof window.__liloPhoneReport === 'function') {
      window.__liloPhoneReport({ attempt, ...obj });
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ attempt, ...obj }));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    window.location.href = 'tauri-voice://phone-form#' + btoa(bin);
  };
  const visible = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  const find = (selector) => [...document.querySelectorAll(selector)].find(visible);
  // The field a person types the number into: the one hinted as a phone
  // field (OpenAI's is `__reservedForPhoneNumberInput_tel`, `type="tel"`,
  // "National number"), else the text field beside a country picker.
  const COUNTRY = /\(\+\d{1,4}\)/;
  const phoneInput = () => {
    const fields = [...document.querySelectorAll('input')]
      .filter(visible)
      .filter((el) => !['hidden', 'email', 'password'].includes(el.type));
    const words = (el) => `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`;
    const hinted = fields.find(
      (el) =>
        el.type === 'tel' ||
        /\btel\b/.test(el.autocomplete || '') ||
        el.inputMode === 'tel' ||
        /phone|telefon|cellul|celular/i.test(words(el)),
    );
    if (hinted) return hinted;
    const picker = [...document.querySelectorAll('select')].find((el) =>
      [...el.options].some((o) => COUNTRY.test(o.textContent || '')),
    );
    if (!picker) return null;
    const scope = picker.form;
    return fields.find((el) => (!scope || el.form === scope) && el.type === 'text') || null;
  };
  const emailInput = () => find('input[type="email"], input[name="email"], input[name="username"], input#email');
  const FIELDS = [
    ['code', () => codeInputs()[0] || find('input[autocomplete="one-time-code"], input[name="code"]')],
    ['password', () => find('input[type="password"]')],
    ['phone', phoneInput],
    ['email', emailInput],
  ];
  const asked = () => {
    for (const [name, locate] of FIELDS) {
      const el = locate();
      if (el) {
        // Combined forms need their email before the password. Other
        // providers show one field per page or retain a filled email.
        if (name === 'password') {
          const email = emailInput();
          if (email && !email.value.trim()) return ['email', email];
        }
        return [name, el];
      }
    }
    return [null, null];
  };
  const alerts = () => {
    const explicit = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-slot="alert-description"], .error-message')]
      .filter(visible)
      .map((el) => el.textContent.trim()).filter(Boolean);
    const inline = [...document.querySelectorAll('form p, form [data-state="error"]')]
      .filter(visible)
      .map((el) => el.textContent.trim())
      .filter((text) => /\b(invalid|incorrect|expired|failed|too many attempts)\b/i.test(text));
    return [...new Set([...explicit, ...inline])].join(' ');
  };

  // Invisible automatic widgets are present on ordinary email forms too.
  // Only an interstitial or a visible interactive challenge needs the PC.
  const challenge = () =>
    /^(just a moment|um momento|un momento)/i.test(document.title) ||
    [...document.querySelectorAll('#challenge-form, #challenge-running')].some(visible) ||
    [...document.querySelectorAll('iframe')].some((frame) => {
      const src = frame.src || frame.title || '';
      if (!visible(frame)) return false;
      const bounds = frame.getBoundingClientRect();
      if (/challenges\.cloudflare\.com|turnstile/i.test(src)) {
        // Interactive checkboxes are compact; automatic probes can be 1px.
        return bounds.width > 100 && bounds.height > 40;
      }
      return /captcha|arkose|challenge/i.test(src) && bounds.height > 150;
    });

  // A page that does not move says what it shows, so the log can tell why.
  const trace = () => {
    const last = window.__liloPhoneTrace || 0;
    if (Date.now() - last < 6000) return;
    window.__liloPhoneTrace = Date.now();
    // Counts and loading state only: no account labels, text or page addresses.
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]), select')].filter(visible).length;
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible).length;
    const frames = document.querySelectorAll('iframe').length;
    const outcome = observation ? `writes=${observation.requests} pending=${observation.pending} status=${observation.status} failures=${observation.failures} submits=${observation.submits} invalid=${observation.invalid} trustedInput=${observation.trustedInput}` : 'observer=missing';
    report({ step: 'trace', message: `page=provider state=${document.readyState} focused=${document.hasFocus()} hidden=${document.hidden} inputs=${inputs} buttons=${buttons} frames=${frames} ${outcome}` });
  };
  // "Continue with Google / Apple / Microsoft / phone": never the one to
  // press for an answer.
  const SOCIAL = /google|apple|microsoft|phone|telefone|telefono|tel[eé]fono|sso|passkey/i;
  const EMAIL_SWITCH = /continue with e-?mail|continuar com (o )?e-?mail|continua con (l'|la )?e-?mail|continuar con (correo|e-?mail)/i;
  const CONTINUE = /^(continue|continuar|continua|next|login|pr[oó]ximo|pr[oó]xima|avan[cç]ar|avanti|log in|sign in|entrar|accedi|verify|verificar|verifica)$/i;
  const SOCIAL_HOST = /(^|\.)(google\.com|apple\.com|live\.com|microsoftonline\.com)$/i;
  const COOKIES = /^(reject non-essential|reject all|rejeitar n[aã]o essenciais|rejeitar tudo|rifiuta (tutti|non essenziali)|rechazar (todo|no esenciales))$/i;
  // What the page says about its question ("Enter the code from your
  // authenticator app"): the phone shows it, so the user knows where the
  // code comes from.
  const prompt = () => {
    const parts = [...document.querySelectorAll('h1, h2, p, label')]
      .filter(visible)
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 3 && text.length < 200);
    return [...new Set(parts)].slice(0, 3).join(' — ').slice(0, 240);
  };
  const once = (key) => {
    try {
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
    } catch (_) {}
    return true;
  };

  // Only e-mail, password and codes travel from the phone, and social buttons
  // are never pressed: landing on a social sign-in means the account has no
  // password yet, so the vendor sent it to Google / Apple / Microsoft.
  if (SOCIAL_HOST.test(location.host)) {
    if (once(`lilo-phone-social-${attempt}`)) history.back();
    return report({
      step: 'error',
      ask: 'email',
      // A key, not prose: the phone page explains it in the user's language.
      message: 'social',
    });
  }
  // A sign-up page means the e-mail or number is on no account: the phone
  // signs in, it never creates an account. Leave the page and say so.
  const signingUp =
    /create-account|sign-?up|register/i.test(location.pathname) ||
    !!find('input[autocomplete="new-password"]');
  if (signingUp) {
    if (once(`lilo-phone-signup-${attempt}`)) history.back();
    return report({ step: 'error', ask: 'email', message: 'signup' });
  }
  if (challenge()) return report({ step: 'challenge' });
  // A cookie banner may cover the form: decline it, once per page.
  const cookies = [...document.querySelectorAll('button')]
    .filter(visible)
    .find((el) => COOKIES.test((el.textContent || '').trim()));
  if (cookies && once(`lilo-phone-cookies-${location.pathname}`)) cookies.click();
  let [ask, input] = asked();

  // An e-mail answers the phone question too: the page is in phone mode (left
  // there by an earlier try), so switch it back to e-mail, once.
  if (field === 'email' && ask === 'phone') {
    const back = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(visible)
      .find((el) => EMAIL_SWITCH.test((el.textContent || '').trim()));
    if (back) {
      if (once(`lilo-phone-mail-${attempt}`)) back.click();
      return;
    }
  }

  // A phone number answers the e-mail question: take the phone sign-in, once.
  // Buttons may be disabled while the page hydrates, and the label may sit
  // in `aria-label`: match on what is shown, click once it is enabled.
  if (field === 'phone' && ask === 'email' && phoneSwitch) {
    const label = (el) => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim();
    const button = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => el.getClientRects().length > 0)
      .find((el) => phoneSwitch.test(label(el)));
    if (button) {
      if (!button.disabled && once(`lilo-phone-tel-${attempt}`)) button.click();
      return;
    }
    // The switch flipped but the phone field is not in yet (the form
    // animates): say what the page shows, the drive loop comes back.
    window.__liloPhoneTrace = 0;
    return trace();
  }
  // A page that shows nothing for a while is held up by something only a
  // person can see: hand it to the PC screen.
  if (ask) window.__liloPhoneBlank = 0;
  else window.__liloPhoneBlank = window.__liloPhoneBlank || Date.now();

  // A password is asked, but the page offers a mailed code instead: take it.
  const codeLink = () => codeSwitch && [...document.querySelectorAll('button, a')]
    .filter(visible)
    .find((el) => codeSwitch.test(el.textContent || ''));
  if (ask === 'password' && codeSwitch) {
    const link = codeLink();
    if (link) {
      if (once(`lilo-phone-switch-${attempt}-${location.pathname}`)) link.click();
      return;
    }
  }

  if (!ask) {
    if (challenge()) return report({ step: 'challenge' });
    // A landing screen: open the form. Rate-limited, the page may be slow.
    const button = (entry && find(entry)) || (entryPattern &&
      [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .find((el) => entryPattern.test((el.textContent || '').trim())));
    const last = window.__liloPhoneEntry || 0;
    if (button && Date.now() - last > 5000) {
      window.__liloPhoneEntry = Date.now();
      button.click();
    } else if (!button && Date.now() - window.__liloPhoneBlank > 10000) {
      // One report per tick: a second navigation would replace the trace.
      trace();
      setTimeout(() => report({ step: 'challenge', message: 'page-unrecognized' }), 300);
    } else {
      trace();
    }
    return;
  }

  const ran = `lilo-phone-${attempt}`;
  let already = false;
  try {
    already = !!sessionStorage.getItem(ran);
  } catch (_) {}
  // Probing, or a page reached after this answer went in: say what it asks.
  if (!field || already || ask !== field) {
    if (!field || ask !== field) report({ step: 'ask', ask, message: prompt() });
    else trace();
    return;
  }
  if (!once(ran)) return;

  const before = alerts();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  // A phone form has a country picker (often a hidden native <select> behind
  // a styled one) and a field for the national number: pick the country by
  // the longest dialling code the number starts with, type the rest.
  let typed = value;
  if (field === 'phone') {
    const digits = value.replace(/\D/g, '');
    const select = [...(input.form || document).querySelectorAll('select')].find((el) =>
      [...el.options].some((o) => /\(\+\d{1,4}\)|^\+\d/.test(o.textContent || o.value)),
    );
    const code = (o) => ((o.textContent || '').match(/\+(\d{1,4})/) || (o.value || '').match(/^\+?(\d{1,4})$/) || [])[1];
    const option = select && [...select.options]
      .filter((o) => code(o) && digits.startsWith(code(o)))
      .sort((a, b) => code(b).length - code(a).length)[0];
    if (option) {
      const pick = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      pick.call(select, option.value);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      typed = digits.slice(code(option).length);
    }
  }
  input.focus();
  const splitCodeInputs = field === 'code' ? codeInputs() : [];
  if (splitCodeInputs.length > 1) {
    [...typed].slice(0, splitCodeInputs.length).forEach((digit, index) => {
      const cell = splitCodeInputs[index];
      setter.call(cell, digit);
      cell.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: digit,
      }));
      cell.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  let edited = false;
  if (splitCodeInputs.length > 1) {
    edited = true;
  } else if (field === 'code' && typeof document.execCommand === 'function') {
      try {
        input.select();
        edited = document.execCommand('insertText', false, typed) && input.value === typed;
      } catch (_) { /* Some embedded engines do not support browser editing. */ }
    }
    window.__liloPhoneEdit = edited ? 'browser' : 'events';
    if (!edited) {
      setter.call(input, typed);
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: typed })
        : new Event('input', { bubbles: true });
      input.dispatchEvent(inputEvent);
    }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Programmatic button.click does not move focus like a physical click.
  // Commit widgets that validate or store their value on blur before submit.
  const filledInput = input.isConnected ? input : FIELDS.find(([name]) => name === field)?.[1]();
  if (filledInput) filledInput.blur();
  // The button that reads like "Continue" first — a login form may hold
  // social buttons that are `type="submit"` too — then a plain submit, then
  // Enter in the field.
  // A combined form has another required field on the same page. Ask the
  // phone for it without submitting incomplete credentials.
  const [nextField, nextInput] = asked();
  if (nextField === 'password' && codeSwitch) {
    const link = codeLink();
    if (link) {
      // Let controlled inputs commit the email before the vendor reads it.
      setTimeout(() => {
        if (window.__liloPhoneAttempt !== attempt || !input.isConnected) return;
        if (once(`lilo-phone-switch-${attempt}-${location.pathname}`)) link.click();
      }, 300);
      return;
    }
  }
  if (nextField && nextField !== field && nextInput && !nextInput.value.trim()) {
    return report({ step: 'ask', ask: nextField, message: prompt() });
  }
  // A provider can keep submit disabled until verification completes.
  const submitStarted = Date.now();
  const submit = () => {
    if (window.__liloPhoneAttempt !== attempt) return;
    // Controlled code components can replace their input on change. Resolve
    // that same field again, and require the value this attempt filled.
    const locate = FIELDS.find(([name]) => name === field);
    const currentInput = input.isConnected ? input : (locate && locate[1]());
    const codeMatches = splitCodeInputs.length > 1
      ? typed.length === splitCodeInputs.length
        && [...typed].every((digit, index) => splitCodeInputs[index]?.value === digit)
      : currentInput?.value === typed;
    if (!currentInput || !codeMatches) {
      window.__liloPhoneDiagnostic = `${field}:submit-input-changed`;
      return report({ step: 'error', ask: field, message: 'The sign-in form changed while filling it. Please try again.' });
    }
    const form = currentInput.form;
    const scope = form || document;
    const text = (el) => (el.textContent || '').trim();
    const sendsPhone = (el) => field === 'phone' && !!phoneSwitch && el.type === 'submit' && phoneSwitch.test(text(el));
    // Keep disabled candidates so no fallback bypasses the vendor's wait.
    const buttons = [...scope.querySelectorAll('button')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => sendsPhone(el) || !SOCIAL.test(text(el)));
    const button = buttons.find(sendsPhone) || buttons.find((el) => CONTINUE.test(text(el))) || buttons.find((el) => el.type === 'submit');
    const unavailable = button && (button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true');
    window.__liloPhoneDiagnostic = `${field}:submit button=${button ? (CONTINUE.test(text(button)) ? text(button) : 'submit') : 'none'} disabled=${!!unavailable} edit=${window.__liloPhoneEdit}${field === 'code' ? ` chars=${currentInput.value.length}` : ''}`;
    if (unavailable) {
      if (Date.now() - submitStarted < 25000) {
        setTimeout(submit, 250);
      } else {
        report({ step: 'error', ask: field, message: 'The sign-in button is not ready. Finish any verification on the PC, then try again.' });
      }
      return;
    }
    if (button) {
      button.click();
    } else {
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      currentInput.dispatchEvent(new KeyboardEvent('keydown', enter));
      currentInput.dispatchEvent(new KeyboardEvent('keyup', enter));
      if (form && form.requestSubmit) form.requestSubmit();
    }
  };
  setTimeout(submit, 300);

  const started = Date.now();
  const watch = () => {
    if (find('input[autocomplete="new-password"]')) return report({ step: 'error', ask: 'email', message: 'signup' });
    if (challenge()) return report({ step: 'challenge' });
    const [now] = asked();
    if (now && now !== field) return report({ step: 'ask', ask: now, message: prompt() });
    const shown = alerts();
    if (shown && shown !== before) return report({ step: 'error', ask: field, message: shown.slice(0, 200) });
    if (Date.now() - started > 25000) return;
    setTimeout(watch, 400);
  };
  setTimeout(watch, 800);
})();
