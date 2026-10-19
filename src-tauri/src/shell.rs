//! The desktop shell. The main window is either the classic app window or —
//! when the desktop companion is on — a borderless, transparent, always-on-top
//! window that shows only LILO. In companion mode settings and history open in
//! a second window, the panel, so LILO stays on screen and its window never
//! changes frame. The voice session stays in the main window (WebKit throttles
//! the microphone of a page nobody can see); the panel is a view of it, see
//! `app/src/app/windowBridge.ts`. The native menus (macOS app menu, the tray
//! everywhere) serve both styles.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, Wry};

use crate::logging;

// Prevent the WebView menu before the app bundle or splash can receive input.
// Do not stop propagation: the companion still opens LILO's own native menu.
const APP_CONTEXT_MENU_SCRIPT: &str = r#"
document.addEventListener('contextmenu', (event) => event.preventDefault(), true);
"#;

pub const MENU_EVENT: &str = "lilo://menu";
pub const SPACE_EVENT: &str = "lilo://companion-space";
pub const STYLE_EVENT: &str = "lilo://shell-style";
/// Where the cursor is over the companion's live parts, logical px, or `null`
/// once it leaves them. macOS sends no mouse moves to a window that is not
/// focused — and the companion rarely is — so hover comes from here.
pub const POINTER_EVENT: &str = "lilo://companion-pointer";
/// Which view the open panel window shows, when another one is asked for.
pub const PANEL_EVENT: &str = "lilo://panel";
pub const PANEL_WINDOW: &str = "panel";

/// Companion window size, logical px. Mirrored by `app/src/features/companion/geometry.ts`.
pub const COMPANION_W: f64 = 820.0;
/// Room above the mascot's own 330px box, where a picture thought grows.
pub const LIFT: f64 = 170.0;
pub const COMPANION_H: f64 = 330.0 + LIFT;
/// The mascot body's horizontal centre, from the window's left edge.
const BODY_X: f64 = COMPANION_W / 2.0;
/// How much of the body must stay on screen on either side of its centre.
const BODY_KEEP: f64 = 108.0;
const POLL_MS: u64 = 50;
/// The classic window, as `tauri.conf.json` declares it.
const CLASSIC_SIZE: (f64, f64) = (1120.0, 780.0);
const CLASSIC_MIN: (f64, f64) = (1024.0, 700.0);
const TRANSPARENT: tauri::window::Color = tauri::window::Color(0, 0, 0, 0);
const PANEL_MIN: (f64, f64) = (420.0, 480.0);
const CLASSIC_BACKGROUND: tauri::window::Color = tauri::window::Color(0x07, 0x0b, 0x14, 0xff);
const SETTLE_MS: u64 = 450;
const ID_PREFIX: &str = "shell:";

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64, pad: f64) -> bool {
        x >= self.x - pad
            && x <= self.x + self.w + pad
            && y >= self.y - pad
            && y <= self.y + self.h + pad
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Classic,
    Companion,
}

/// The views the panel window can show, and the size each opens at (logical
/// px; fitted to the screen).
const PANELS: [(&str, f64, f64); 4] = [
    ("settings", 1040.0, 720.0),
    ("conversations", 460.0, 720.0),
    ("transcript", 460.0, 720.0),
    ("commands", 1040.0, 720.0),
];

/// What the menus need to know about the session, pushed by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub live: bool,
    pub busy: bool,
    pub muted: bool,
    pub speaking: bool,
    pub playing: bool,
    pub paused: bool,
    pub budget: Option<String>,
    /// Menu labels in the UI language; English defaults fill the gaps.
    pub labels: HashMap<String, String>,
}

impl Flags {
    fn label(&self, key: &str) -> String {
        self.labels
            .get(key)
            .cloned()
            .unwrap_or_else(|| default_label(key).to_string())
    }

    /// Everything the tray menu shows; `speaking` flips every turn and only
    /// matters to the app menu, so it must not rebuild an open tray menu.
    fn tray_key(&self) -> Flags {
        Flags {
            speaking: false,
            ..self.clone()
        }
    }
}

fn default_label(key: &str) -> &'static str {
    match key {
        "conversation" => "Conversation",
        "voice" => "Voice",
        "media" => "Media",
        "window" => "Window",
        "help" => "Help",
        "start" => "Start Conversation",
        "end" => "End Conversation",
        "interrupt" => "Interrupt LILO",
        "mute" => "Mute Microphone",
        "play" => "Play",
        "pause" => "Pause",
        "next" => "Next Track",
        "previous" => "Previous Track",
        "stop" => "Stop Music",
        "settings" => "Settings…",
        "downloadLogs" => "Download Logs…",
        "conversations" => "Conversations…",
        "transcript" => "Transcript",
        "commands" => "Voice Commands",
        "show" => "Show LILO",
        "hide" => "Hide LILO",
        "recenter" => "Move LILO to Center",
        "quit" => "Quit LILO",
        "companion" => "Desktop Companion",
        "statusIdle" => "LILO — Ready",
        "statusConnecting" => "LILO — Connecting…",
        "statusLive" => "LILO — Listening",
        "statusMuted" => "LILO — Microphone off",
        _ => "",
    }
}

/// Free space, logical px, from the mascot's centre to each work-area edge.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Space {
    pub left: f64,
    pub right: f64,
}

pub struct Shell {
    mode: Mutex<Mode>,
    companion: AtomicBool,
    hits: Mutex<Vec<Rect>>,
    ignoring: AtomicBool,
    flags: Mutex<Flags>,
    revision: AtomicU64,
    moved: AtomicU64,
    /// The app's theme, for windows opened after it was set; `None`: the system's.
    theme: Mutex<Option<tauri::Theme>>,
    /// The user hid LILO from a menu. The one truth for Show/Hide: the window
    /// is created hidden and shown later by its page, so asking the window
    /// when a menu is built gave a label that no longer held when clicked.
    hidden: AtomicBool,
    store: PathBuf,
    #[cfg(target_os = "macos")]
    app_menu: Mutex<Option<AppMenu>>,
}

impl Shell {
    pub fn new(data_dir: PathBuf) -> Self {
        let store = data_dir.join("shell.json");
        let companion = read_store(&store)
            .get("companion")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        Self {
            mode: Mutex::new(if companion {
                Mode::Companion
            } else {
                Mode::Classic
            }),
            companion: AtomicBool::new(companion),
            hits: Mutex::new(Vec::new()),
            ignoring: AtomicBool::new(false),
            flags: Mutex::new(Flags::default()),
            revision: AtomicU64::new(0),
            moved: AtomicU64::new(0),
            theme: Mutex::new(None),
            hidden: AtomicBool::new(false),
            store,
            #[cfg(target_os = "macos")]
            app_menu: Mutex::new(None),
        }
    }

    fn mode(&self) -> Mode {
        *self.mode.lock().expect("shell poisoned")
    }

    pub fn flags(&self) -> Flags {
        self.flags.lock().expect("shell poisoned").clone()
    }

    /// Bumped whenever the tray menu must be rebuilt.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    /// Whether the user hid LILO from a menu.
    pub fn hidden(&self) -> bool {
        self.hidden.load(Ordering::SeqCst)
    }

    pub fn companion(&self) -> bool {
        self.companion.load(Ordering::SeqCst)
    }

    fn saved_origin(&self) -> Option<PhysicalPosition<i32>> {
        let value = read_store(&self.store);
        Some(PhysicalPosition::new(
            i32::try_from(value.get("x")?.as_i64()?).ok()?,
            i32::try_from(value.get("y")?.as_i64()?).ok()?,
        ))
    }

    fn save_origin(&self, at: PhysicalPosition<i32>) {
        self.write_store("x", at.x.into());
        self.write_store("y", at.y.into());
    }

    fn write_store(&self, key: &str, value: serde_json::Value) {
        let mut stored = read_store(&self.store);
        stored.insert(key.to_string(), value);
        if let Some(dir) = self.store.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let body = serde_json::Value::Object(stored).to_string();
        if let Err(error) = std::fs::write(&self.store, body) {
            logging::log("shell", &format!("could not save the shell state: {error}"));
        }
    }
}

fn read_store(path: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// A work area in physical px: origin and size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Keep the mascot's body and the controls under it on the work area; the
/// empty sides of the window may hang off the screen.
pub fn clamp_origin(at: (f64, f64), area: Area, scale: f64) -> (f64, f64) {
    let min_x = area.x - (BODY_X - BODY_KEEP) * scale;
    let max_x = area.x + area.w - (BODY_X + BODY_KEEP) * scale;
    // The empty room above the mascot may hang off the top of the screen.
    let min_y = area.y - LIFT * scale;
    let max_y = area.y + area.h - COMPANION_H * scale;
    (
        at.0.clamp(min_x, max_x.max(min_x)),
        at.1.clamp(min_y, max_y.max(min_y)),
    )
}

pub fn space(at: (f64, f64), area: Area, scale: f64) -> Space {
    let centre = at.0 + BODY_X * scale;
    Space {
        left: ((centre - area.x) / scale).max(0.0),
        right: ((area.x + area.w - centre) / scale).max(0.0),
    }
}

/// Bottom-right of the work area, where a companion is out of the way.
pub fn default_origin(area: Area, scale: f64) -> (f64, f64) {
    (
        area.x + area.w - (BODY_X + BODY_KEEP + 40.0) * scale,
        area.y + area.h - (COMPANION_H + 24.0) * scale,
    )
}

fn area_of(monitor: &tauri::Monitor) -> Area {
    let work = monitor.work_area();
    Area {
        x: work.position.x as f64,
        y: work.position.y as f64,
        w: work.size.width as f64,
        h: work.size.height as f64,
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::MAIN_WINDOW)
}

/// The monitor under the mascot, falling back to the window's, then the primary.
fn monitor_for(
    app: &AppHandle,
    window: &WebviewWindow,
    at: PhysicalPosition<i32>,
) -> Option<tauri::Monitor> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let x = at.x as f64 + BODY_X * scale;
    let y = at.y as f64 + (LIFT + 165.0) * scale;
    app.monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn companion_frame(app: &AppHandle, window: &WebviewWindow, wanted: Option<PhysicalPosition<i32>>) {
    clear_material(window);
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(false);
    // After the frame change: on macOS switching the style mask back to
    // borderless restores the window's default opaque background, which
    // showed as a grey slab behind LILO after a panel had been open.
    let _ = window.set_background_color(Some(TRANSPARENT));
    let _ = window.set_resizable(false);
    let _ = window.set_min_size(None::<tauri::Size>);
    let _ = window.set_size(tauri::LogicalSize::new(COMPANION_W, COMPANION_H));
    let origin = wanted
        .filter(|at| {
            let scale = window.scale_factor().unwrap_or(1.0);
            app.monitor_from_point(
                at.x as f64 + BODY_X * scale,
                at.y as f64 + (LIFT + 100.0) * scale,
            )
            .ok()
            .flatten()
            .is_some()
        })
        .or_else(|| {
            let monitor = app.primary_monitor().ok().flatten()?;
            let (x, y) = default_origin(area_of(&monitor), monitor.scale_factor());
            Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        });
    if let Some(origin) = origin {
        let origin = settle(app, window, origin);
        let _ = window.set_position(origin);
    }
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_shadow(false);
}

/// The app window as it always was: framed, resizable, a normal window.
fn classic_frame(window: &WebviewWindow) {
    clear_material(window);
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_always_on_top(false);
    let _ = window.set_visible_on_all_workspaces(false);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_decorations(true);
    #[cfg(target_os = "macos")]
    let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
    let _ = window.set_shadow(true);
    let _ = window.set_background_color(Some(CLASSIC_BACKGROUND));
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(CLASSIC_MIN.0, CLASSIC_MIN.1)));
    let _ = window.set_size(tauri::LogicalSize::new(CLASSIC_SIZE.0, CLASSIC_SIZE.1));
    let _ = window.center();
}

/// Takes any material off the main window. On macOS `set_effects(None)` does
/// nothing, so an effect view would stay behind the transparent companion as a
/// grey slab; it is removed directly, on the main thread like AppKit wants.
#[cfg(target_os = "macos")]
fn clear_material(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = window_vibrancy::clear_vibrancy(&target);
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_material(window: &WebviewWindow) {
    let _ = window.set_effects(None);
}

fn panel_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(PANEL_WINDOW)
}

/// Settings and history beside the companion: a normal window with the system
/// title bar and, on macOS, the system's own material behind the page (what
/// native apps draw their sidebars on; always active, so the page never dims
/// under the user's eyes). Mica exists only on Windows 11 and cannot be
/// verified from here, and Linux has no material: there the window is opaque.
///
/// It is its own window, never the main one reframed: the companion's frame
/// stays exactly as it was built, and closing the panel is a plain close.
pub fn open_panel(app: &AppHandle, panel: &str) -> Result<(), String> {
    let (name, width, height) = PANELS
        .iter()
        .copied()
        .find(|(name, _, _)| *name == panel)
        .ok_or_else(|| format!("unknown panel {panel}"))?;
    let (w, h) = fit_panel(app, width, height);
    let minimum = match name {
        "settings" => CLASSIC_MIN,
        "commands" => (900.0, 600.0),
        _ => PANEL_MIN,
    };
    let minimum = (minimum.0.min(w), minimum.1.min(h));
    if let Some(window) = panel_window(app) {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(minimum.0, minimum.1)));
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let _ = window.emit_to(PANEL_WINDOW, PANEL_EVENT, name);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let material = cfg!(target_os = "macos");
    let shell = app.state::<Shell>();
    let style = if shell.companion() {
        "companion"
    } else {
        "classic"
    };
    let launch = serde_json::json!({ "panel": name, "material": material });
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        PANEL_WINDOW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("LILO")
    .inner_size(w, h)
    .min_inner_size(minimum.0, minimum.1)
    .resizable(true)
    .center()
    .theme(*shell.theme.lock().expect("shell poisoned"))
    // The page shows it once its first frame is ready: a fresh webview
    // paints white until then.
    .visible(false)
    .devtools(false)
    .initialization_script(APP_CONTEXT_MENU_SCRIPT)
    .initialization_script(format!(
        "window.__LILO_SHELL__ = {style:?}; window.__LILO_PANEL__ = {launch};"
    ));
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        builder = builder
            .transparent(true)
            .background_color(TRANSPARENT)
            .title_bar_style(tauri::TitleBarStyle::Visible)
            .effects(
                EffectsBuilder::new()
                    .effect(Effect::Sidebar)
                    .state(EffectState::Active)
                    .build(),
            );
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.background_color(CLASSIC_BACKGROUND);
    }
    // WebView2 shares one browser environment per app: a window created with
    // other arguments than the main one fails to open.
    #[cfg(windows)]
    if let Some(args) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == crate::MAIN_WINDOW)
        .and_then(|window| window.additional_browser_args.clone())
    {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    // Only for a page that never gets as far as showing itself.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    });
    Ok(())
}

/// A panel size that fits the screen under the companion.
fn fit_panel(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let monitor = main_window(app)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(monitor) => {
            let area = area_of(&monitor);
            let scale = monitor.scale_factor();
            (
                width.min(area.w / scale * 0.94),
                height.min(area.h / scale * 0.94),
            )
        }
        None => (width, height),
    }
}

fn close_panel(app: &AppHandle) {
    if let Some(window) = panel_window(app) {
        let _ = window.close();
    }
}

/// Clamp an origin to the mascot's monitor.
fn settle(
    app: &AppHandle,
    window: &WebviewWindow,
    at: PhysicalPosition<i32>,
) -> PhysicalPosition<i32> {
    let Some(monitor) = monitor_for(app, window, at) else {
        return at;
    };
    let (x, y) = clamp_origin(
        (at.x as f64, at.y as f64),
        area_of(&monitor),
        monitor.scale_factor(),
    );
    PhysicalPosition::new(x.round() as i32, y.round() as i32)
}

fn current_space(app: &AppHandle) -> Option<Space> {
    let window = main_window(app)?;
    let at = window.outer_position().ok()?;
    let monitor = monitor_for(app, &window, at)?;
    Some(space(
        (at.x as f64, at.y as f64),
        area_of(&monitor),
        monitor.scale_factor(),
    ))
}

/// Called once from `setup`: create the main window in the chosen style,
/// install the menus and the click-through watcher.
///
/// The window is declared in `tauri.conf.json` with `create: false` and built
/// here, so the page knows its style before its first script runs (the splash
/// and the page background differ) and so it is transparent from birth — a
/// window cannot become transparent later.
pub fn setup(app: &AppHandle, data_dir: PathBuf) -> tauri::Result<()> {
    app.manage(Shell::new(data_dir));
    let shell = app.state::<Shell>();
    let companion = shell.companion();
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == crate::MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let style = if companion { "companion" } else { "classic" };
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .devtools(false)
        .initialization_script(APP_CONTEXT_MENU_SCRIPT)
        .initialization_script(format!("window.__LILO_SHELL__ = {style:?};"));
    // The classic window paints the app's night colour before the page does;
    // the companion has nothing behind LILO.
    let window = if companion {
        builder
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .build()?
    } else {
        builder.background_color(CLASSIC_BACKGROUND).build()?
    };
    if companion {
        companion_frame(app, &window, shell.saved_origin());
    }
    #[cfg(target_os = "macos")]
    install_app_menu(app);
    watch_cursor(app);
    Ok(())
}

/// Turn the desktop companion on or off, live: the frontend swaps its shell on
/// the style event.
pub fn set_companion(app: &AppHandle, enabled: bool) {
    let shell = app.state::<Shell>();
    shell.companion.store(enabled, Ordering::SeqCst);
    shell.write_store("companion", enabled.into());
    let Some(window) = main_window(app) else {
        return;
    };
    if enabled {
        *shell.mode.lock().expect("shell poisoned") = Mode::Companion;
        companion_frame(app, &window, shell.saved_origin());
    } else {
        if shell.mode() == Mode::Companion {
            if let Ok(at) = window.outer_position() {
                shell.save_origin(at);
            }
        }
        *shell.mode.lock().expect("shell poisoned") = Mode::Classic;
        // The classic window has its own panels.
        close_panel(app);
        shell.hits.lock().expect("shell poisoned").clear();
        shell.ignoring.store(false, Ordering::SeqCst);
        classic_frame(&window);
    }
    let _ = window.show();
    let _ = app.emit(STYLE_EVENT, if enabled { "companion" } else { "classic" });
    #[cfg(target_os = "macos")]
    if let Some(menu) = shell.app_menu.lock().expect("shell poisoned").as_ref() {
        let _ = menu.companion.set_checked(enabled);
    }
    set_hidden(app, false);
    if enabled {
        if let Some(space) = current_space(app) {
            let _ = app.emit(SPACE_EVENT, space);
        }
    }
}

/// Transparent parts of the companion let clicks through to whatever is
/// underneath. The OS only offers "the whole window ignores the mouse", so the
/// cursor is watched here and the switch flipped as it crosses the live parts
/// the frontend reports. Where the cursor position is unavailable (Wayland) the
/// window simply keeps its clicks.
fn watch_cursor(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(POLL_MS));
        let mut pointer: Option<(i32, i32)> = None;
        loop {
            ticker.tick().await;
            let shell = app.state::<Shell>();
            let Some(window) = main_window(&app) else {
                continue;
            };
            let mut over = None;
            let want = if shell.mode() == Mode::Companion {
                let (Ok(cursor), Ok(at), Ok(scale)) = (
                    app.cursor_position(),
                    window.outer_position(),
                    window.scale_factor(),
                ) else {
                    continue;
                };
                let x = (cursor.x - at.x as f64) / scale;
                let y = (cursor.y - at.y as f64) / scale;
                let hits = shell.hits.lock().expect("shell poisoned");
                let inside = hits.iter().any(|rect| rect.contains(x, y, 4.0));
                if inside {
                    over = Some((x.round() as i32, y.round() as i32));
                }
                !inside
            } else {
                false
            };
            if over != pointer {
                pointer = over;
                let _ = app.emit(
                    POINTER_EVENT,
                    over.map(|(x, y)| serde_json::json!({ "x": x, "y": y })),
                );
            }
            if shell.ignoring.load(Ordering::SeqCst) != want
                && window.set_ignore_cursor_events(want).is_ok()
            {
                shell.ignoring.store(want, Ordering::SeqCst);
            }
        }
    });
}

/// The window moved: once it has settled, keep the mascot on screen, remember
/// where it is and tell the frontend which side has room for the bubble.
pub fn on_moved(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.mode() != Mode::Companion {
        return;
    }
    let ticket = shell.moved.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;
        let shell = app.state::<Shell>();
        if shell.moved.load(Ordering::SeqCst) != ticket || shell.mode() != Mode::Companion {
            return;
        }
        let Some(window) = main_window(&app) else {
            return;
        };
        let Ok(at) = window.outer_position() else {
            return;
        };
        let settled = settle(&app, &window, at);
        if settled != at {
            let _ = window.set_position(settled);
        }
        shell.save_origin(settled);
        if let Some(space) = current_space(&app) {
            let _ = app.emit(SPACE_EVENT, space);
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    set_hidden(app, false);
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
    set_hidden(app, true);
}

/// Record whether LILO is hidden and bring every menu's Show/Hide in line.
fn set_hidden(app: &AppHandle, hidden: bool) {
    let shell = app.state::<Shell>();
    shell.hidden.store(hidden, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if let Some(menu) = shell.app_menu.lock().expect("shell poisoned").as_ref() {
        let flags = shell.flags();
        let _ = menu
            .show
            .set_text(flags.label(if hidden { "show" } else { "hide" }));
    }
    refresh_menus(app);
}

fn recenter(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    if !app.state::<Shell>().companion() {
        let _ = window.center();
        show_main(app);
        return;
    }
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };
    let area = area_of(&monitor);
    let scale = monitor.scale_factor();
    let at = PhysicalPosition::new(
        (area.x + (area.w - COMPANION_W * scale) / 2.0).round() as i32,
        (area.y + (area.h - COMPANION_H * scale) / 2.0).round() as i32,
    );
    let shell = app.state::<Shell>();
    let _ = window.set_position(at);
    shell.save_origin(at);
    show_main(app);
}

/// Menu ids this module owns. Returns false for anyone else's.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
    let Some(action) = id.strip_prefix(ID_PREFIX) else {
        return false;
    };
    match action {
        "show" => {
            if app.state::<Shell>().hidden.load(Ordering::SeqCst) {
                show_main(app);
            } else {
                hide_main(app);
            }
        }
        "recenter" => recenter(app),
        "companion" => {
            let enabled = !app.state::<Shell>().companion();
            set_companion(app, enabled);
        }
        "quit" => app.exit(0),
        other => {
            let panel = matches!(
                other,
                "settings" | "conversations" | "transcript" | "commands"
            );
            if panel && app.state::<Shell>().companion() {
                if let Err(error) = open_panel(app, other) {
                    logging::log("shell", &format!("panel failed: {error}"));
                }
                return true;
            }
            if panel {
                show_main(app);
            }
            let _ = app.emit(MENU_EVENT, other);
        }
    }
    true
}

fn item(
    app: &AppHandle,
    id: &str,
    text: &str,
    enabled: bool,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, format!("{ID_PREFIX}{id}"), text, enabled, accel)
}

/// Session, media and window controls, shared by the tray and the mascot's
/// context menu.
pub fn append_controls(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
    let flags = app.state::<Shell>().flags();
    let status = if flags.busy {
        flags.label("statusConnecting")
    } else if flags.live && flags.muted {
        flags.label("statusMuted")
    } else if flags.live {
        flags.label("statusLive")
    } else {
        flags.label("statusIdle")
    };
    let status = match &flags.budget {
        Some(budget) => format!("{status} · {budget}"),
        None => status,
    };
    menu.append(&MenuItem::new(app, status, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let session = if flags.live || flags.busy {
        flags.label("end")
    } else {
        flags.label("start")
    };
    menu.append(&item(app, "session", &session, true, None)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        format!("{ID_PREFIX}mute"),
        flags.label("mute"),
        flags.live,
        flags.muted,
        None::<&str>,
    )?)?;
    let toggle = if flags.paused {
        flags.label("play")
    } else {
        flags.label("pause")
    };
    let media = Submenu::with_id_and_items(
        app,
        format!("{ID_PREFIX}media-menu"),
        flags.label("media"),
        flags.playing,
        &[
            &item(app, "media-toggle", &toggle, flags.playing, None)?,
            &item(
                app,
                "media-previous",
                &flags.label("previous"),
                flags.playing,
                None,
            )?,
            &item(app, "media-next", &flags.label("next"), flags.playing, None)?,
            &item(app, "media-stop", &flags.label("stop"), flags.playing, None)?,
        ],
    )?;
    menu.append(&media)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    menu.append(&item(
        app,
        "conversations",
        &flags.label("conversations"),
        true,
        None,
    )?)?;
    menu.append(&item(
        app,
        "commands",
        &flags.label("commands"),
        true,
        None,
    )?)?;
    let settings = flags.label("settings");
    menu.append(&item(app, "settings", &settings, true, None)?)?;
    menu.append(&item(
        app,
        "download-logs",
        &flags.label("downloadLogs"),
        true,
        None,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let hidden = app.state::<Shell>().hidden.load(Ordering::SeqCst);
    let show = if hidden {
        flags.label("show")
    } else {
        flags.label("hide")
    };
    menu.append(&item(app, "show", &show, true, None)?)?;
    let companion = app.state::<Shell>().companion();
    if companion {
        menu.append(&item(
            app,
            "recenter",
            &flags.label("recenter"),
            true,
            None,
        )?)?;
    }
    menu.append(&CheckMenuItem::with_id(
        app,
        format!("{ID_PREFIX}companion"),
        flags.label("companion"),
        true,
        companion,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(app, "quit", &flags.label("quit"), true, None)?)?;
    Ok(())
}

fn refresh_menus(app: &AppHandle) {
    app.state::<Shell>().revision.fetch_add(1, Ordering::SeqCst);
    crate::statusbar::refresh(app);
}

#[tauri::command]
pub fn shell_hit_regions(shell: tauri::State<'_, Shell>, rects: Vec<Rect>) {
    *shell.hits.lock().expect("shell poisoned") = rects;
}

#[tauri::command]
pub fn shell_state(app: AppHandle, shell: tauri::State<'_, Shell>, flags: Flags) {
    let previous = {
        let mut current = shell.flags.lock().expect("shell poisoned");
        std::mem::replace(&mut *current, flags.clone())
    };
    if previous == flags {
        return;
    }
    #[cfg(target_os = "macos")]
    update_app_menu(&shell, &flags);
    if previous.tray_key() != flags.tray_key() {
        refresh_menus(&app);
    }
}

#[tauri::command]
pub fn shell_space(app: AppHandle) -> Option<Space> {
    current_space(&app)
}

/// Open a panel beside the companion, or bring the open one to that view.
#[tauri::command]
pub fn shell_panel(
    app: AppHandle,
    shell: tauri::State<'_, Shell>,
    panel: String,
) -> Result<(), String> {
    if !shell.companion() {
        return Err("panels open beside the desktop companion".into());
    }
    open_panel(&app, &panel)
}

/// The windows' appearance follows the app's theme (`None`: the system's), so
/// title bar and material match the page drawn on them.
#[tauri::command]
pub fn shell_theme(app: AppHandle, shell: tauri::State<'_, Shell>, theme: Option<String>) {
    let theme = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    *shell.theme.lock().expect("shell poisoned") = theme;
    for window in [main_window(&app), panel_window(&app)]
        .into_iter()
        .flatten()
    {
        let _ = window.set_theme(theme);
    }
}

#[tauri::command]
pub fn shell_style(shell: tauri::State<'_, Shell>) -> &'static str {
    if shell.companion() {
        "companion"
    } else {
        "classic"
    }
}

#[tauri::command]
pub fn shell_set_companion(app: AppHandle, enabled: bool) {
    set_companion(&app, enabled);
}

/// The mascot's right-click menu: the tray's controls, where the user is.
#[tauri::command]
pub fn shell_popup_menu(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app).ok_or("no main window")?;
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    append_controls(&app, &menu).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
struct AppMenu {
    conversation: Submenu<Wry>,
    voice: Submenu<Wry>,
    media: Submenu<Wry>,
    window: Submenu<Wry>,
    help: Submenu<Wry>,
    settings: MenuItem<Wry>,
    download_logs: MenuItem<Wry>,
    session: MenuItem<Wry>,
    conversations: MenuItem<Wry>,
    transcript: MenuItem<Wry>,
    interrupt: MenuItem<Wry>,
    mute: CheckMenuItem<Wry>,
    media_toggle: MenuItem<Wry>,
    previous: MenuItem<Wry>,
    next: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    show: MenuItem<Wry>,
    recenter: MenuItem<Wry>,
    companion: CheckMenuItem<Wry>,
    commands: MenuItem<Wry>,
}

/// The native menu bar. Only on macOS: on Windows and Linux a menu bar is
/// part of a window, and this window has no frame to carry one — the tray is
/// the native place there.
#[cfg(target_os = "macos")]
fn install_app_menu(app: &AppHandle) {
    match build_app_menu(app) {
        Ok((menu, handles)) => {
            if let Err(error) = app.set_menu(menu) {
                logging::log("shell", &format!("app menu failed: {error}"));
                return;
            }
            *app.state::<Shell>()
                .app_menu
                .lock()
                .expect("shell poisoned") = Some(handles);
        }
        Err(error) => logging::log("shell", &format!("app menu failed: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, AppMenu)> {
    use tauri::menu::AboutMetadata;
    let flags = Flags::default();
    let l = |key: &str| flags.label(key);

    let settings = item(app, "settings", &l("settings"), true, Some("CmdOrCtrl+,"))?;
    let download_logs = item(app, "download-logs", &l("downloadLogs"), true, None)?;
    let lilo = Submenu::with_items(
        app,
        "LILO",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &download_logs,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let session = item(app, "session", &l("start"), true, Some("CmdOrCtrl+Enter"))?;
    let conversations = item(
        app,
        "conversations",
        &l("conversations"),
        true,
        Some("CmdOrCtrl+Shift+C"),
    )?;
    let transcript = item(
        app,
        "transcript",
        &l("transcript"),
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let conversation = Submenu::with_items(
        app,
        l("conversation"),
        true,
        &[
            &session,
            &PredefinedMenuItem::separator(app)?,
            &conversations,
            &transcript,
        ],
    )?;
    let interrupt = item(
        app,
        "interrupt",
        &l("interrupt"),
        false,
        Some("CmdOrCtrl+."),
    )?;
    let mute = CheckMenuItem::with_id(
        app,
        format!("{ID_PREFIX}mute"),
        l("mute"),
        false,
        false,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let voice = Submenu::with_items(app, l("voice"), true, &[&mute, &interrupt])?;
    let media_toggle = item(
        app,
        "media-toggle",
        &l("pause"),
        false,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let previous = item(
        app,
        "media-previous",
        &l("previous"),
        false,
        Some("CmdOrCtrl+Shift+Left"),
    )?;
    let next = item(
        app,
        "media-next",
        &l("next"),
        false,
        Some("CmdOrCtrl+Shift+Right"),
    )?;
    let stop = item(app, "media-stop", &l("stop"), false, None)?;
    let media = Submenu::with_items(
        app,
        l("media"),
        true,
        &[
            &media_toggle,
            &PredefinedMenuItem::separator(app)?,
            &previous,
            &next,
            &stop,
        ],
    )?;
    let show = item(app, "show", &l("hide"), true, None)?;
    let recenter = item(app, "recenter", &l("recenter"), true, None)?;
    let companion = CheckMenuItem::with_id(
        app,
        format!("{ID_PREFIX}companion"),
        l("companion"),
        true,
        app.state::<Shell>().companion(),
        None::<&str>,
    )?;
    let window = Submenu::with_items(
        app,
        l("window"),
        true,
        &[
            &show,
            &recenter,
            &PredefinedMenuItem::separator(app)?,
            &companion,
        ],
    )?;
    let commands = item(app, "commands", &l("commands"), true, Some("CmdOrCtrl+/"))?;
    let help = Submenu::with_items(app, l("help"), true, &[&commands])?;

    let menu = Menu::with_items(
        app,
        &[&lilo, &edit, &conversation, &voice, &media, &window, &help],
    )?;
    Ok((
        menu,
        AppMenu {
            conversation,
            voice,
            media,
            window,
            help,
            settings,
            download_logs,
            session,
            conversations,
            transcript,
            interrupt,
            mute,
            media_toggle,
            previous,
            next,
            stop,
            show,
            recenter,
            companion,
            commands,
        },
    ))
}

#[cfg(target_os = "macos")]
fn update_app_menu(shell: &Shell, flags: &Flags) {
    let guard = shell.app_menu.lock().expect("shell poisoned");
    let Some(menu) = guard.as_ref() else {
        return;
    };
    let l = |key: &str| flags.label(key);
    let _ = menu.conversation.set_text(l("conversation"));
    let _ = menu.voice.set_text(l("voice"));
    let _ = menu.media.set_text(l("media"));
    let _ = menu.window.set_text(l("window"));
    let _ = menu.help.set_text(l("help"));
    let _ = menu.settings.set_text(l("settings"));
    let _ = menu.download_logs.set_text(l("downloadLogs"));
    let _ = menu.session.set_text(if flags.live || flags.busy {
        l("end")
    } else {
        l("start")
    });
    let _ = menu.conversations.set_text(l("conversations"));
    let _ = menu.transcript.set_text(l("transcript"));
    let _ = menu.interrupt.set_text(l("interrupt"));
    let _ = menu.interrupt.set_enabled(flags.speaking);
    let _ = menu.mute.set_text(l("mute"));
    let _ = menu.mute.set_enabled(flags.live);
    let _ = menu.mute.set_checked(flags.muted);
    let _ = menu
        .media_toggle
        .set_text(if flags.paused { l("play") } else { l("pause") });
    for (entry, key) in [
        (&menu.media_toggle, None),
        (&menu.previous, Some("previous")),
        (&menu.next, Some("next")),
        (&menu.stop, Some("stop")),
    ] {
        if let Some(key) = key {
            let _ = entry.set_text(l(key));
        }
        let _ = entry.set_enabled(flags.playing);
    }
    let _ = menu
        .show
        .set_text(l(if shell.hidden.load(Ordering::SeqCst) {
            "show"
        } else {
            "hide"
        }));
    let _ = menu.recenter.set_text(l("recenter"));
    let _ = menu.recenter.set_enabled(shell.companion());
    let _ = menu.companion.set_text(l("companion"));
    let _ = menu.commands.set_text(l("commands"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_desktop_workspaces_have_room_for_two_columns() {
        assert!(super::CLASSIC_MIN.0 >= 1024.0 && super::CLASSIC_MIN.1 >= 700.0);
        let commands = super::PANELS
            .iter()
            .find(|panel| panel.0 == "commands")
            .unwrap();
        assert!(commands.1 >= 1000.0 && commands.2 >= 700.0);
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];
        assert_eq!(main["minWidth"].as_f64(), Some(super::CLASSIC_MIN.0));
        assert_eq!(main["minHeight"].as_f64(), Some(super::CLASSIC_MIN.1));
    }
    use super::*;

    const AREA: Area = Area {
        x: 0.0,
        y: 25.0,
        w: 1440.0,
        h: 875.0,
    };

    #[test]
    fn the_mascot_is_kept_on_the_work_area_while_the_empty_sides_may_hang_off() {
        // Far right: the body centre stops BODY_KEEP short of the edge.
        let (x, _) = clamp_origin((5_000.0, 100.0), AREA, 1.0);
        assert_eq!(x + BODY_X, AREA.w - BODY_KEEP);
        // Far left: the window's left half is allowed off screen.
        let (x, _) = clamp_origin((-5_000.0, 100.0), AREA, 1.0);
        assert_eq!(x + BODY_X, BODY_KEEP);
        assert!(x < 0.0);
        // Vertically the mascot's box stays on the work area; the room above
        // it may hang off the top.
        assert_eq!(clamp_origin((100.0, -5_000.0), AREA, 1.0).1, 25.0 - LIFT);
        assert_eq!(
            clamp_origin((100.0, 5_000.0), AREA, 1.0).1,
            25.0 + 875.0 - COMPANION_H
        );
    }

    #[test]
    fn clamping_scales_with_the_monitor() {
        let area = Area {
            x: 0.0,
            y: 0.0,
            w: 2880.0,
            h: 1800.0,
        };
        let (x, y) = clamp_origin((10_000.0, 10_000.0), area, 2.0);
        assert_eq!(x + BODY_X * 2.0, 2880.0 - BODY_KEEP * 2.0);
        assert_eq!(y, 1800.0 - COMPANION_H * 2.0);
    }

    #[test]
    fn space_is_measured_from_the_mascot_in_logical_pixels() {
        let area = Area {
            x: 0.0,
            y: 0.0,
            w: 2880.0,
            h: 1800.0,
        };
        let space = space((0.0, 0.0), area, 2.0);
        assert_eq!(space.left, BODY_X);
        assert_eq!(space.right, 1440.0 - BODY_X);
    }

    #[test]
    fn the_default_origin_is_already_settled() {
        let origin = default_origin(AREA, 1.0);
        assert_eq!(clamp_origin(origin, AREA, 1.0), origin);
    }

    #[test]
    fn labels_fall_back_to_english() {
        let mut flags = Flags::default();
        assert_eq!(flags.label("quit"), "Quit LILO");
        flags.labels.insert("quit".into(), "Sair do LILO".into());
        assert_eq!(flags.label("quit"), "Sair do LILO");
    }

    #[test]
    fn a_hit_region_has_a_little_slack() {
        let rect = Rect {
            x: 10.0,
            y: 10.0,
            w: 20.0,
            h: 20.0,
        };
        assert!(rect.contains(8.0, 12.0, 4.0));
        assert!(!rect.contains(0.0, 12.0, 4.0));
    }
}
