//! What a plugin is allowed to put on screen.
//!
//! Declarative by design: a plugin says *what* it wants to show and the host
//! decides how. The alternatives were rejected on purpose —
//!   * remote HTML: the app's CSP forbids it, and a marketplace plugin would
//!     otherwise get a browser inside the browser;
//!   * an iframe with its own JS: a huge surface for code we do not review,
//!     and it would fragment the design system;
//!   * native React components: only viable for first-party plugins.
//!
//! A declarative description also keeps the headless headless Linux device honest: the
//! UI is a contribution, never a requirement, so a plugin that ships a page
//! still runs with no display at all.
//!
//! Vocabulary, kept deliberately small — each kind maps to a control the app
//! already has:
//!
//! ```json
//! {
//!   "settings": [
//!     { "key": "token", "kind": "password", "label": "Access token" },
//!     { "key": "quality", "kind": "select", "label": "Quality",
//!       "options": [{ "value": "high", "label": "High" }] },
//!     { "key": "volume", "kind": "range", "label": "Volume", "min": 0, "max": 100 },
//!     { "key": "enabled", "kind": "switch", "label": "Enabled" }
//!   ],
//!   "status": [{ "label": "Account", "value": "connected", "state": "ok" }],
//!   "actions": [{ "label": "Reconnect", "tool": "spotify_reconnect" }]
//! }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The control a setting is rendered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    /// Rendered as a text field that hides what is typed.
    Password,
    Switch,
    Select,
    Range,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingField {
    /// Key the value is stored under and handed back to the plugin.
    pub key: String,
    pub kind: FieldKind,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    /// Only for `select`.
    #[serde(default)]
    pub options: Vec<SelectOption>,
    /// Only for `range`.
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
    /// Shown (and saved) until the user changes it. Without one a switch
    /// reads as off and a select as empty, whatever the plugin assumes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

/// A read-only line, e.g. "Account — connected".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusRow {
    pub label: String,
    pub value: String,
    /// `ok` | `warn` | `bad`, matching the app's status chips.
    #[serde(default)]
    pub state: Option<String>,
}

/// A button that runs one of the plugin's own tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiAction {
    pub label: String,
    /// Defaulted rather than required: a missing tool then fails validation
    /// with a message that names the action, instead of a serde error.
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub requires_confirm: bool,
}

/// A list that changes while the plugin runs (recent songs, saved notes). The
/// description never holds the rows: they come from `tool`, which returns
/// `{"items": [{"label", "detail", "action": {"label", "tool", "args"}}]}`.
/// The page calls it when it opens, after one of its actions, and whenever
/// the plugin publishes an event, so a static description can show live data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSource {
    pub title: String,
    #[serde(default)]
    pub tool: String,
    /// Shown while the list has no rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSource {
    pub title: String,
    pub tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSource {
    pub title: String,
    pub tool: String,
    pub max: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormFieldKind {
    Text,
    Number,
    Select,
    Switch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub key: String,
    pub label: String,
    pub kind: FormFieldKind,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Vec<SelectOption>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub max_length: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSource {
    pub title: String,
    pub tool: String,
    pub submit_label: String,
    pub fields: Vec<FormField>,
}

/// A background scene behind the voice stage. The plugin names a tool that
/// returns `{"scene": {"kind", "intensity", "night"}}`; the host calls it now
/// and every `everySecs`, and also applies a `scene` found in any other tool
/// result, so a voice command changes the background at once. The host draws
/// from its own fixed vocabulary: `none`, `clear`, `sun`, `clouds`, `fog`,
/// `rain`, `snow`, `storm`, `heat`, `cold`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSource {
    #[serde(default)]
    pub tool: String,
    #[serde(default = "default_scene_every")]
    pub every_secs: u64,
}

fn default_scene_every() -> u64 {
    60
}

/// A scene poll faster than this is refused: it would wake a plugin process
/// for nothing.
pub const MIN_SCENE_EVERY_SECS: u64 = 15;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginUi {
    /// Plugin-owned display text, keyed by locale and original English text.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub localized: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub settings: Vec<SettingField>,
    #[serde(default)]
    pub status: Vec<StatusRow>,
    #[serde(default)]
    pub actions: Vec<UiAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<ListSource>,
    /// Additional independent sections, using the same live-list contract.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lists: Vec<ListSource>,
    #[serde(default)]
    pub cards: Vec<CardSource>,
    #[serde(default)]
    pub progress: Vec<ProgressSource>,
    #[serde(default)]
    pub forms: Vec<FormSource>,
}

impl PluginUi {
    /// Validate static tool references against the plugin's own inventory.
    pub fn validate_tools<'a>(
        &self,
        tools: impl IntoIterator<Item = &'a str>,
    ) -> Result<(), String> {
        let owned: std::collections::HashSet<&str> = tools.into_iter().collect();
        for tool in self
            .actions
            .iter()
            .map(|action| action.tool.as_str())
            .chain(self.scene.iter().map(|scene| scene.tool.as_str()))
            .chain(self.cards.iter().map(|card| card.tool.as_str()))
            .chain(self.progress.iter().map(|item| item.tool.as_str()))
            .chain(self.forms.iter().map(|form| form.tool.as_str()))
            .chain(
                self.list
                    .iter()
                    .chain(self.lists.iter())
                    .map(|list| list.tool.as_str()),
            )
        {
            if !owned.contains(tool) {
                return Err(format!("UI names unowned tool `{tool}`"));
            }
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.settings.is_empty()
            && self.status.is_empty()
            && self.actions.is_empty()
            && self.scene.is_none()
            && self.list.is_none()
            && self.lists.is_empty()
            && self.cards.is_empty()
            && self.progress.is_empty()
            && self.forms.is_empty()
    }

    /// Reject a description the host cannot render, instead of showing a
    /// broken page: a select without options or a range without bounds is a
    /// plugin bug that deserves a clear error at load time.
    pub fn validate(&self) -> Result<(), String> {
        if self.settings.len() > 32 || self.status.len() > 32 || self.actions.len() > 16 {
            return Err("plugin UI is limited to 32 settings/status rows and 16 actions".into());
        }
        for field in &self.settings {
            if field.key.len() > 64
                || field.label.trim().is_empty()
                || field.label.len() > 120
                || field.help.as_ref().is_some_and(|text| text.len() > 400)
                || field
                    .placeholder
                    .as_ref()
                    .is_some_and(|text| text.len() > 160)
                || field.options.len() > 20
            {
                return Err(
                    "setting labels, keys, help, placeholders or options exceed bounds".into(),
                );
            }
            match field.kind {
                FieldKind::Select if field.options.is_empty() => {
                    return Err(format!(
                        "setting `{}` is a select with no options",
                        field.key
                    ));
                }
                FieldKind::Range => {
                    let min = field.min.unwrap_or(0);
                    let max = field.max.unwrap_or(100);
                    if min >= max {
                        return Err(format!(
                            "setting `{}` has an empty range ({min}..{max})",
                            field.key
                        ));
                    }
                }
                _ => {}
            }
            if field.key.trim().is_empty() {
                return Err("a setting has no key".to_string());
            }
        }
        for row in &self.status {
            if row.label.trim().is_empty()
                || row.label.len() > 120
                || row.value.len() > 400
                || row
                    .state
                    .as_deref()
                    .is_some_and(|state| !["ok", "warn", "bad", "neutral"].contains(&state))
            {
                return Err("status rows must use bounded text and a supported state".into());
            }
        }
        for action in &self.actions {
            if action.tool.trim().is_empty()
                || action.tool.len() > 128
                || action.label.trim().is_empty()
                || action.label.len() > 120
                || serde_json::to_vec(&action.args).is_ok_and(|value| value.len() > 16 * 1024)
            {
                return Err(format!("action `{}` runs no tool", action.label));
            }
        }
        if let Some(scene) = &self.scene {
            if scene.tool.trim().is_empty() {
                return Err("the scene names no tool".to_string());
            }
            if scene.every_secs < MIN_SCENE_EVERY_SECS {
                return Err(format!(
                    "the scene polls every {}s; the minimum is {MIN_SCENE_EVERY_SECS}s",
                    scene.every_secs
                ));
            }
        }
        if self.lists.len() + usize::from(self.list.is_some()) > 8 {
            return Err("a plugin page supports at most eight lists".into());
        }
        for list in self.list.iter().chain(self.lists.iter()) {
            if list.tool.trim().is_empty() {
                return Err(format!("list `{}` names no tool", list.title));
            }
            if list.tool.len() > 128
                || list.title.trim().is_empty()
                || list.title.len() > 160
                || list.empty.as_ref().is_some_and(|text| text.len() > 400)
            {
                return Err("list title, tool or empty text exceeds its bounds".into());
            }
        }
        if self.cards.len() > 8 || self.progress.len() > 8 || self.forms.len() > 8 {
            return Err(
                "a plugin page supports at most eight cards, progress bars and forms of each type"
                    .into(),
            );
        }
        for card in &self.cards {
            if card.title.trim().is_empty()
                || card.title.len() > 160
                || card.tool.trim().is_empty()
                || card.tool.len() > 128
            {
                return Err("card title and tool must be nonempty and bounded".into());
            }
        }
        for item in &self.progress {
            if item.title.trim().is_empty()
                || item.title.len() > 160
                || item.tool.trim().is_empty()
                || item.tool.len() > 128
                || !item.max.is_finite()
                || item.max <= 0.0
                || item.max > 1_000_000_000.0
            {
                return Err("progress title, tool and positive maximum must be bounded".into());
            }
        }
        for form in &self.forms {
            if form.title.trim().is_empty()
                || form.title.len() > 160
                || form.tool.trim().is_empty()
                || form.tool.len() > 128
                || form.submit_label.trim().is_empty()
                || form.submit_label.len() > 80
                || form.fields.is_empty()
                || form.fields.len() > 12
            {
                return Err("forms need a bounded title/tool/submit label and 1–12 fields".into());
            }
            let mut keys = std::collections::HashSet::new();
            for field in &form.fields {
                if field.key.trim().is_empty()
                    || field.key.len() > 64
                    || field.label.trim().is_empty()
                    || field.label.len() > 120
                    || !keys.insert(&field.key)
                {
                    return Err("form field keys must be unique and labels bounded".into());
                }
                match field.kind {
                    FormFieldKind::Select
                        if field.options.is_empty() || field.options.len() > 20 =>
                    {
                        return Err("form selects need 1–20 options".into())
                    }
                    FormFieldKind::Number
                        if !matches!(field.min, Some(v) if v.is_finite())
                            || !matches!(field.max, Some(v) if v.is_finite())
                            || field.min >= field.max =>
                    {
                        return Err("form numbers need finite ordered bounds".into())
                    }
                    FormFieldKind::Text if !(1..=600).contains(&field.max_length.unwrap_or(0)) => {
                        return Err("form text needs maxLength 1–600".into())
                    }
                    _ => {}
                }
                let mut option_values = std::collections::HashSet::new();
                for option in &field.options {
                    if option.value.len() > 120
                        || option.label.trim().is_empty()
                        || option.label.len() > 120
                        || !option_values.insert(&option.value)
                    {
                        return Err("form select options must be unique and bounded".into());
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_multiple_lists_are_bounded_and_validated() {
        let list = serde_json::json!({"title":"Review", "tool":"review_today"});
        let ui: PluginUi =
            serde_json::from_value(serde_json::json!({"lists":[list.clone(),list.clone()]}))
                .unwrap();
        assert!(!ui.is_empty());
        assert!(ui.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&ui).unwrap()["lists"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let excessive: PluginUi =
            serde_json::from_value(serde_json::json!({"lists":vec![list;9]})).unwrap();
        assert!(excessive.validate().is_err());
        let invalid: PluginUi =
            serde_json::from_value(serde_json::json!({"lists":[{"title":"Review","tool":""}]}))
                .unwrap();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn test_ui_sources_and_actions_must_name_owned_tools() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "lists":[{"title":"Review","tool":"review_today"}],
            "actions":[{"label":"Start","tool":"study_start"}]
        }))
        .unwrap();
        assert!(ui.validate_tools(["review_today", "study_start"]).is_ok());
        assert!(ui.validate_tools(["study_start"]).is_err());
        assert!(ui.validate_tools(["review_today"]).is_err());
    }

    #[test]
    fn test_cards_progress_forms_and_destructive_confirmations_are_bounded() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "actions":[{"label":"Erase","tool":"erase","requiresConfirm":true}],
            "cards":[{"title":"Goal","tool":"goal"}],
            "progress":[{"title":"Reviews","tool":"reviews","max":5}],
            "forms":[{"title":"Routine","tool":"save","submitLabel":"Save","fields":[
                {"key":"minutes","label":"Minutes","kind":"number","required":true,"min":5,"max":120}
            ]}]
        })).unwrap();
        assert!(ui.validate().is_ok());
        assert!(ui
            .validate_tools(["erase", "goal", "reviews", "save"])
            .is_ok());
        assert!(ui.validate_tools(["erase", "goal", "reviews"]).is_err());
        assert!(ui.actions[0].requires_confirm);
        let invalid: PluginUi = serde_json::from_value(serde_json::json!({"forms":[{"title":"Bad","tool":"save","submitLabel":"Save","fields":[{"key":"n","label":"N","kind":"number","min":5}]}]})).unwrap();
        assert!(invalid.validate().is_err());
        let invalid_progress: PluginUi = serde_json::from_value(
            serde_json::json!({"progress":[{"title":"Bad","tool":"p","max":0}]}),
        )
        .unwrap();
        assert!(invalid_progress.validate().is_err());
    }

    #[test]
    fn plugin_owned_labels_can_be_translated_without_new_controls() {
        let ui: super::PluginUi = serde_json::from_value(serde_json::json!({
            "localized": {"es": {"Notes": "Notas"}},
            "status": [{"label": "Notes", "value": "Ready"}]
        }))
        .unwrap();
        let value = serde_json::to_value(ui).unwrap();
        assert_eq!(value["localized"]["es"]["Notes"], "Notas");
    }
    use super::*;

    #[test]
    fn a_full_description_parses() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "settings": [
                { "key": "token", "kind": "password", "label": "Access token" },
                { "key": "volume", "kind": "range", "label": "Volume", "min": 0, "max": 100 },
                { "key": "enabled", "kind": "switch", "label": "Enabled" },
                { "key": "q", "kind": "select", "label": "Quality",
                  "options": [{ "value": "high", "label": "High" }] }
            ],
            "status": [{ "label": "Account", "value": "connected", "state": "ok" }],
            "actions": [{ "label": "Reconnect", "tool": "spotify_reconnect" }]
        }))
        .unwrap();
        assert_eq!(ui.settings.len(), 4);
        assert_eq!(ui.status[0].state.as_deref(), Some("ok"));
        assert_eq!(ui.actions[0].tool, "spotify_reconnect");
        assert!(ui.validate().is_ok());
    }

    #[test]
    fn an_empty_description_is_valid_and_empty() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(ui.is_empty());
        assert!(ui.validate().is_ok());
    }

    #[test]
    fn a_select_without_options_is_refused() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "settings": [{ "key": "q", "kind": "select", "label": "Quality" }]
        }))
        .unwrap();
        assert!(ui.validate().unwrap_err().contains("no options"));
    }

    #[test]
    fn an_inverted_range_is_refused() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "settings": [{ "key": "v", "kind": "range", "label": "V", "min": 100, "max": 10 }]
        }))
        .unwrap();
        assert!(ui.validate().unwrap_err().contains("empty range"));
    }

    #[test]
    fn a_scene_source_is_validated() {
        let ok: PluginUi = serde_json::from_value(serde_json::json!({
            "scene": { "tool": "weather_scene" }
        }))
        .unwrap();
        assert_eq!(ok.scene.as_ref().unwrap().every_secs, 60);
        assert!(ok.validate().is_ok());
        let fast: PluginUi = serde_json::from_value(serde_json::json!({
            "scene": { "tool": "x", "everySecs": 1 }
        }))
        .unwrap();
        assert!(fast.validate().unwrap_err().contains("minimum"));
    }

    #[test]
    fn a_list_is_a_page_and_must_name_its_tool() {
        let ok: PluginUi = serde_json::from_value(serde_json::json!({
            "list": { "title": "Recently played", "tool": "history_list" }
        }))
        .unwrap();
        assert!(!ok.is_empty());
        assert!(ok.validate().is_ok());
        let bad: PluginUi = serde_json::from_value(serde_json::json!({
            "list": { "title": "Recently played" }
        }))
        .unwrap();
        assert!(bad.validate().unwrap_err().contains("names no tool"));
    }

    #[test]
    fn an_action_without_a_tool_is_refused() {
        let ui: PluginUi = serde_json::from_value(serde_json::json!({
            "actions": [{ "label": "Do nothing" }]
        }))
        .unwrap();
        assert!(ui.validate().unwrap_err().contains("runs no tool"));
    }
}
