use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::logging;

pub const TOPIC: &str = "statusbar";
pub const EVENT: &str = "lilo://statusbar";
const TRAY_ID: &str = "lilo-status";
const ACTION_PREFIX: &str = "statusbar:action:";
const MAX_ACTIONS: usize = 6;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub label: String,
    pub tool: String,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub source: String,
    pub label: String,
    pub ends_at: Option<i64>,
    pub left: Option<i64>,
    pub actions: Vec<Action>,
    #[serde(skip)]
    order: u64,
}

#[derive(Default)]
pub struct StatusBar {
    items: Mutex<HashMap<String, Item>>,
    next_order: Mutex<u64>,
    tray: Mutex<Option<TrayIcon>>,
    shown_title: Mutex<Option<String>>,
    shown_actions: Mutex<Option<Vec<Action>>>,
    shown_revision: Mutex<Option<u64>>,
}

fn clean(text: &str, max: usize) -> String {
    text.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

pub fn parse(source: &str, payload: &Value) -> Option<Item> {
    let label = clean(payload.get("label")?.as_str()?, 24);
    if label.is_empty() {
        return None;
    }
    let actions = payload
        .get("actions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|action| {
                    let label = clean(action.get("label")?.as_str()?, 32);
                    let tool = action.get("tool")?.as_str()?.trim().to_string();
                    (!label.is_empty() && !tool.is_empty()).then(|| Action {
                        label,
                        tool,
                        args: action.get("args").cloned().unwrap_or(Value::Null),
                    })
                })
                .take(MAX_ACTIONS)
                .collect()
        })
        .unwrap_or_default();
    Some(Item {
        source: source.to_string(),
        label,
        ends_at: payload.get("endsAt").and_then(Value::as_i64),
        left: payload.get("left").and_then(Value::as_i64),
        actions,
        order: 0,
    })
}

fn clock(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let (hours, minutes, rest) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{rest:02}")
    } else {
        format!("{minutes:02}:{rest:02}")
    }
}

pub fn render(item: &Item, now: i64) -> String {
    match (item.ends_at, item.left) {
        (Some(ends_at), _) => format!("{} {}", item.label, clock(ends_at - now)),
        (None, Some(left)) => format!("{} {}", item.label, clock(left)),
        (None, None) => item.label.clone(),
    }
}

impl StatusBar {
    pub fn apply(&self, source: &str, payload: &Value) -> Option<Item> {
        let mut items = self.items.lock().expect("statusbar poisoned");
        match parse(source, payload) {
            Some(mut item) => {
                let mut order = self.next_order.lock().expect("statusbar poisoned");
                *order += 1;
                item.order = *order;
                items.insert(source.to_string(), item);
            }
            None => {
                items.remove(source);
            }
        }
        items.values().max_by_key(|item| item.order).cloned()
    }

    pub fn current(&self) -> Option<Item> {
        let items = self.items.lock().expect("statusbar poisoned");
        items.values().max_by_key(|item| item.order).cloned()
    }

    /// The tray is always there — it is LILO's home when the window is a bare
    /// companion. A plugin's status item puts its title next to the icon and
    /// its actions on top of the menu.
    fn show(&self, app: &AppHandle, item: Option<&Item>, now: i64) {
        let title = item.map(|item| render(item, now));
        let actions = item.map(|item| item.actions.clone());
        let revision = app.state::<crate::shell::Shell>().revision();
        let mut shown_title = self.shown_title.lock().expect("statusbar poisoned");
        let mut shown_actions = self.shown_actions.lock().expect("statusbar poisoned");
        let mut shown_revision = self.shown_revision.lock().expect("statusbar poisoned");
        let mut tray = self.tray.lock().expect("statusbar poisoned");
        if tray.is_none() {
            match tray_builder(app).build(app) {
                Ok(icon) => {
                    *tray = Some(icon);
                    *shown_title = None;
                    *shown_actions = None;
                    *shown_revision = None;
                }
                Err(error) => {
                    logging::log("statusbar", &format!("tray unavailable: {error}"));
                    return;
                }
            }
        }
        let Some(icon) = tray.as_ref() else {
            return;
        };
        if *shown_title != title {
            let _ = icon.set_title(title.as_deref());
            *shown_title = title;
        }
        if *shown_actions != actions || *shown_revision != Some(revision) {
            match build_menu(app, actions.as_deref().unwrap_or_default()) {
                Ok(menu) => {
                    let _ = icon.set_menu(Some(menu));
                }
                Err(error) => logging::log("statusbar", &format!("menu failed: {error}")),
            }
            *shown_actions = actions;
            *shown_revision = Some(revision);
        }
    }
}

fn tray_builder(app: &AppHandle) -> TrayIconBuilder<tauri::Wry> {
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("LILO")
        .show_menu_on_left_click(true);
    // macOS draws a template image in the menu bar's own colour; elsewhere
    // the app icon reads best on the taskbar.
    #[cfg(target_os = "macos")]
    let builder = match Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
        Ok(image) => builder.icon(image).icon_as_template(true),
        Err(_) => builder,
    };
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(image) => builder.icon(image.clone()),
        None => builder,
    };
    #[cfg(target_os = "macos")]
    let _ = app;
    builder
}

fn build_menu(app: &AppHandle, actions: &[Action]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for (index, action) in actions.iter().enumerate() {
        menu.append(&MenuItem::with_id(
            app,
            format!("{ACTION_PREFIX}{index}"),
            &action.label,
            true,
            None::<&str>,
        )?)?;
    }
    if !actions.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    crate::shell::append_controls(app, &menu)?;
    Ok(menu)
}

/// Rebuild the tray menu now (the shell's state changed), on the main thread.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let bar = handle.state::<StatusBar>();
        let current = bar.current();
        bar.show(&handle, current.as_ref(), chrono::Utc::now().timestamp());
    });
}

pub fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if crate::shell::on_menu(app, id) {
        return;
    }
    let Some(index) = id
        .strip_prefix(ACTION_PREFIX)
        .and_then(|rest| rest.parse::<usize>().ok())
    else {
        return;
    };
    let Some(item) = app.state::<StatusBar>().current() else {
        return;
    };
    let Some(action) = item.actions.get(index).cloned() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            crate::run_owned_tool(&app, &item.source, &action.tool, &action.args).await
        {
            logging::log("statusbar", &format!("{} failed: {error}", action.tool));
        }
    });
}

pub fn publish(app: &AppHandle, source: &str, payload: &Value) {
    let current = app.state::<StatusBar>().apply(source, payload);
    let _ = app.emit(EVENT, &current);
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let bar = handle.state::<StatusBar>();
                let current = bar.current();
                bar.show(&handle, current.as_ref(), chrono::Utc::now().timestamp());
            });
        }
    });
}

#[tauri::command]
pub fn statusbar_current(bar: tauri::State<'_, StatusBar>) -> Option<Item> {
    bar.current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(label: &str, ends_at: Option<i64>, left: Option<i64>) -> Item {
        Item {
            source: "s".into(),
            label: label.into(),
            ends_at,
            left,
            actions: Vec::new(),
            order: 1,
        }
    }

    #[test]
    fn a_countdown_renders_minutes_and_seconds_and_never_goes_negative() {
        let focus = item("Focus", Some(1_000 + 25 * 60), None);
        assert_eq!(render(&focus, 1_000), "Focus 25:00");
        assert_eq!(render(&focus, 1_000 + 25 * 60 - 61), "Focus 01:01");
        assert_eq!(render(&focus, 5_000), "Focus 00:00");
        assert_eq!(render(&item("Deep", Some(3_700), None), 0), "Deep 1:01:40");
        assert_eq!(render(&item("Recording", None, None), 0), "Recording");
    }

    #[test]
    fn a_paused_item_shows_the_time_it_has_left_without_counting() {
        let paused = item("Focus (paused)", None, Some(754));
        assert_eq!(render(&paused, 0), "Focus (paused) 12:34");
        assert_eq!(render(&paused, 99_999), "Focus (paused) 12:34");
    }

    #[test]
    fn the_latest_item_wins_and_an_empty_payload_clears_only_its_source() {
        let bar = StatusBar::default();
        assert_eq!(bar.current(), None);
        bar.apply("com.a", &json!({ "label": "Focus", "endsAt": 60 }));
        let shown = bar.apply("com.b", &json!({ "label": "Upload" })).unwrap();
        assert_eq!(shown.source, "com.b");
        let back = bar.apply("com.b", &json!({})).unwrap();
        assert_eq!(render(&back, 0), "Focus 01:00");
        assert_eq!(bar.apply("com.a", &Value::Null), None);
    }

    #[test]
    fn labels_and_actions_are_bounded_and_malformed_actions_dropped() {
        let parsed = parse(
            "com.a",
            &json!({
                "label": "  Fo\ncus with a very long name indeed  ",
                "endsAt": 9,
                "actions": [
                    { "label": "Pause", "tool": "p_pause" },
                    { "label": "", "tool": "p_x" },
                    { "label": "No tool" },
                    { "label": "Skip", "tool": "p_skip", "args": { "to": "break" } }
                ]
            }),
        )
        .unwrap();
        assert_eq!(parsed.label, "Focus with a very long n");
        assert_eq!(parsed.ends_at, Some(9));
        assert_eq!(parsed.actions.len(), 2);
        assert_eq!(parsed.actions[1].args["to"], "break");
        assert!(parse("com.a", &json!({ "label": "   " })).is_none());
    }
}
