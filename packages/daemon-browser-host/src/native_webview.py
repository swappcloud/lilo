"""Private Linux WebKitGTK phone-login engine; JSON travels only over stdio."""
import base64
import json
import math
import re
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit
from phone_flow import PhoneFlow

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2

WIDTH, HEIGHT = 430, 740
DRIVER = (Path(__file__).resolve().parents[2] / "phone-login" / "driver.js").read_text(encoding="utf-8")
OBSERVER = (Path(__file__).resolve().parents[2] / "phone-login" / "observer.js").read_text(encoding="utf-8")


class Engine:
    def __init__(self):
        self.provider = None
        self.flow = PhoneFlow()
        self.window = Gtk.Window()
        self.window.set_decorated(False)
        self.window.set_default_size(WIDTH, HEIGHT)
        self.window.set_resizable(False)
        self.context = WebKit2.WebContext.new_ephemeral()
        self.context.set_sandbox_enabled(True)
        self.view = WebKit2.WebView.new_with_context(self.context)
        self.view.set_size_request(WIDTH, HEIGHT)
        self.view.get_settings().set_enable_developer_extras(False)
        manager = self.view.get_user_content_manager()
        manager.add_script(WebKit2.UserScript.new(OBSERVER,
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START, None, None))
        manager.add_script(WebKit2.UserScript.new(
            'window.__liloPhoneProgress={step:"working"};window.__liloPhoneReport=r=>{if(r.attempt===window.__liloPhoneAttempt&&["working","ask","challenge","error"].includes(r.step))window.__liloPhoneProgress={step:r.step,ask:r.ask,message:typeof r.message==="string"?r.message.slice(0,240):""}};',
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START, None, None))
        self.view.connect("decide-policy", self.policy)
        self.view.connect("permission-request", lambda _view, request: (request.deny(), True)[1])
        self.context.connect("download-started", lambda _context, download: download.cancel())
        self.window.add(self.view)
        self.window.show_all()
        self.window.present()
        self.window.get_window().focus(Gdk.CURRENT_TIME)
        self.view.grab_focus()

    def reply(self, request, result=None, error=False, kind=None):
        # Never print exception details, credentials or diagnostics.
        print(json.dumps({"id": request["id"], "error": error, "kind": kind, "result": result}, separators=(",", ":")), flush=True)

    def policy(self, _view, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            url = urlsplit(uri)
            allowed = self.provider and url.scheme == "https" and url.hostname in self.provider["navigationHosts"]
            if not allowed:
                decision.ignore()
                return True
            if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
                decision.ignore()
                self.view.load_uri(uri)
                return True
        return False

    def evaluate(self, script, done):
        def complete(view, result, _data):
            try:
                value = view.evaluate_javascript_finish(result)
                done(value.to_string() if value.is_string() else None)
            except Exception:
                done(None)
        self.view.evaluate_javascript(script, -1, None, None, None, complete, None)

    def drive(self, field=None, value="", done=lambda _value: None, submitting=False):
        form = self.provider["phoneForm"]
        values = {"__FIELD__": field, "__VALUE__": value, "__ATTEMPT__": self.flow.attempt,
                  "__ENTRY__": form.get("entry", ""), "__ENTRY_TEXT__": form.get("entryText", ""),
                  "__CODE_SWITCH__": form.get("codeSwitch", ""), "__PHONE_SWITCH__": form.get("phoneSwitch", ""),
                  "__CODE_INPUTS__": form.get("codeInputs", "")}
        script = re.sub("|".join(values), lambda match: json.dumps(values[match.group()]), DRIVER)
        if submitting:
            script = 'window.__liloPhoneProgress={step:"working"};' + script
        self.evaluate(script, done)

    def snapshot(self, request):
        uri = self.view.get_uri() or "about:blank"
        url = urlsplit(uri)
        origin = f"{url.scheme}://{url.netloc}" if url.scheme == "https" else "about:blank"
        frame = {"phase": "login", "origin": origin, "step": "working"}
        def progress(_value=None):
            def read(value):
                try:
                    data = json.loads(value or "{}")
                    frame.update(self.flow.observe(data, GLib.get_monotonic_time() / 1000000))
                except (ValueError, TypeError):
                    pass
                self.observe(request, frame)
            self.evaluate("JSON.stringify(window.__liloPhoneProgress||{})", read)
        def no_account():
            if self.flow.progress["step"] == "error" and not self.flow.answer:
                frame.update(self.flow.progress)
                self.observe(request, frame)
            elif url.scheme == "https" and url.hostname in self.provider["navigationHosts"]:
                field, value = self.flow.answer or (None, "")
                self.drive(field, value, done=progress)
            else:
                progress()
        capture = self.provider["capture"]
        if origin != capture["origin"]:
            no_account()
            return
        # Same-origin provider capture; no HTTP fingerprint substitution.
        script = capture["script"]
        def session_ready(value):
            try:
                session = json.loads(value or "null")
                token = session.get("accessToken") if isinstance(session, dict) else None
                email = session.get("user", {}).get("email") if isinstance(session, dict) else None
                if not isinstance(token, str) or not 0 < len(token) <= 32768 or not isinstance(email, str) or not 0 < len(email.strip()) <= 320:
                    no_account()
                    return
            except (ValueError, TypeError, AttributeError):
                no_account()
                return
            def cookies_ready(manager, result, _data):
                try:
                    cookies = manager.get_cookies_finish(result)
                    parts = sorted((cookie.get_name(), cookie.get_value()) for cookie in cookies
                                   if re.fullmatch(capture["cookiePattern"], cookie.get_name()))
                    header = "; ".join(f"{name}={value}" for name, value in parts)
                    self.reply(request, {"frame": {"phase": "connected", "origin": origin},
                                         "account": {"provider": self.provider["id"], "session": session, "sessionCookie": header}})
                except Exception:
                    self.reply(request, error=True)
            self.context.get_cookie_manager().get_cookies(self.provider["homeUrl"], None, cookies_ready, None)
        self.evaluate(script, session_ready)

    def observe(self, request, frame):
        script = '''JSON.stringify((()=>{const s=window.__liloPhoneObserver||{};const d=window.__liloPhoneDiagnostic||"";const fields=[...document.querySelectorAll("input")].filter(e=>e.type!=="hidden"&&e.getClientRects().length&&!e.disabled);return {state:document.readyState,focused:document.hasFocus(),hidden:document.hidden,inputs:fields.length,filled:fields.filter(e=>!!e.value).length,valid:fields.every(e=>e.validity.valid),requests:s.requests||0,pending:s.pending||0,status:s.status||0,failures:s.failures||0,submits:s.submits||0,invalid:s.invalid||0,trustedInput:s.trustedInput===true,submitReached:/:submit(?: |$)/.test(d),inputChanged:d.includes("submit-input-changed"),buttonDisabled:d.includes("disabled=true"),browserEdit:d.includes("edit=browser"),driverError:!!window.__liloPhoneEvalError}})())'''
        def ready(value):
            try:
                diagnostic = json.loads(value or "{}")
            except (ValueError, TypeError):
                diagnostic = {}
            if frame["step"] == "challenge":
                self.image(request, frame, diagnostic)
            else:
                self.reply(request, {"frame": frame, "account": None, "diagnostic": diagnostic})
        self.evaluate(script, ready)

    def image(self, request, frame, diagnostic=None):
        def ready(view, result, _data):
            try:
                surface = view.get_snapshot_finish(result)
                pixels = Gdk.pixbuf_get_from_surface(surface, 0, 0, WIDTH, HEIGHT)
                ok, jpeg = pixels.save_to_bufferv("jpeg", ["quality"], ["55"])
                if not ok or len(jpeg) > 300000:
                    raise ValueError("Frame too large")
                frame.update(image=base64.b64encode(jpeg).decode("ascii"), width=WIDTH, height=HEIGHT)
                self.reply(request, {"frame": frame, "account": None, "diagnostic": diagnostic or {}})
            except Exception:
                self.reply(request, error=True)
        self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, ready, None)

    def dispatch(self, request):
        try:
            action = request["action"]
            if action == "start":
                self.provider = request["provider"]
                self.view.load_uri(self.provider["loginUrl"])
            elif action == "snapshot":
                self.snapshot(request)
                return False
            elif action == "answer":
                if request.get("field") not in ("email", "password", "code", "phone") or not isinstance(request.get("value"), str) or not 0 < len(request["value"]) <= 4096:
                    raise ValueError("Invalid answer")
                self.flow.begin(request["field"], request["value"], GLib.get_monotonic_time() / 1000000)
                self.drive(request["field"], request["value"], lambda _value: self.reply(request, {}), submitting=True)
                return False
            elif action == "visual":
                pass  # Compatibility with previously cached phone pages.
            elif action == "click":
                x, y = request["x"], request["y"]
                if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y)) or not 0 <= x < WIDTH or not 0 <= y < HEIGHT:
                    raise ValueError("Invalid coordinates")
                self.input(["mousemove", str(round(x)), str(round(y)), "click", "1"])
            elif action == "text":
                text = request.get("text")
                if not isinstance(text, str) or len(text) > 4096 or "\x00" in text:
                    raise ValueError("Invalid text")
                self.input(["type", "--clearmodifiers", "--file", "-"], text)
            elif action == "key":
                keys = {"Enter": "Return", "Tab": "Tab", "Backspace": "BackSpace", "Escape": "Escape"}
                self.input(["key", "--clearmodifiers", keys[request["key"]]])
            elif action == "scroll":
                dy = request["dy"]
                if not isinstance(dy, (int, float)) or not math.isfinite(dy) or abs(dy) > HEIGHT:
                    raise ValueError("Invalid scroll")
                if dy:
                    self.input(["click", "--repeat", str(max(1, round(abs(dy) / 80))), "5" if dy > 0 else "4"])
            elif action != "frame":
                raise ValueError("Unsupported action")
            self.reply(request, {})
        except Exception as error:
            self.reply(request, error=True, kind=type(error).__name__)
        return False

    @staticmethod
    def input(args, text=None):
        subprocess.run(["xdotool", *args], input=text, encoding="utf-8", stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=True)


def reader():
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            GLib.idle_add(Gtk.main_quit)
            return
        if len(line) > 65536:
            GLib.idle_add(Gtk.main_quit)
            return
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), int):
                raise ValueError("Invalid request")
            GLib.idle_add(engine.dispatch, request)
        except (ValueError, TypeError):
            GLib.idle_add(Gtk.main_quit)
            return


if __name__ == "__main__":
    engine = Engine()
    threading.Thread(target=reader, daemon=True).start()
    Gtk.main()
