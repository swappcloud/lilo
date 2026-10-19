//! Location: where the user is, for every plugin that needs it.
//!
//! A first-party, in-process plugin. It owns *finding* the location and
//! publishes it as the retained `location.changed` event; consumers such as
//! weather subscribe and never know where the fix came from.
//!
//! Sources, most trusted first:
//!   * `manual` — a city typed in its settings, geocoded by Open-Meteo;
//!   * `device` — the platform's location service, reported by the host UI
//!     through `location_report` (a headless board has none);
//!   * `network` — an IP lookup (keyless), city or region accuracy.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::registry::{CommandDescriptor, CommandScope};
use crate::error::{AppError, Result};
use crate::plugins::bus::Publisher;
use crate::plugins::ui::{FieldKind, SettingField, StatusRow, UiAction};
use crate::plugins::{BoxFuture, PluginManifest, PluginUi, ToolProvider};
use crate::tools::ToolDescriptor;

pub const PLUGIN_ID: &str = "lilo.location";
pub const TOPIC_CHANGED: &str = "location.changed";

/// A device fix older than this no longer beats a fresh network lookup.
const DEVICE_FIX_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Moving less than this is not a change worth announcing.
const MIN_MOVE_KM: f64 = 1.0;
/// Within this distance, a device fix keeps the place name the network gave.
const NAME_RADIUS_KM: f64 = 40.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
    /// City or region; empty when only coordinates are known.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub timezone: String,
    /// `manual`, `device` or `network`.
    pub source: String,
    #[serde(default)]
    pub accuracy_km: f64,
}

impl Location {
    /// Parse a `location.changed` payload.
    pub fn from_payload(payload: &Value) -> Option<Location> {
        let location: Location = serde_json::from_value(payload.clone()).ok()?;
        let valid = location.latitude.is_finite()
            && location.longitude.is_finite()
            && (-90.0..=90.0).contains(&location.latitude)
            && (-180.0..=180.0).contains(&location.longitude);
        valid.then_some(location)
    }

    fn label(&self) -> String {
        match (self.name.is_empty(), self.country.is_empty()) {
            (false, false) => format!("{}, {}", self.name, self.country),
            (false, true) => self.name.clone(),
            _ => format!("{:.2}, {:.2}", self.latitude, self.longitude),
        }
    }
}

/// Great-circle distance in km.
pub fn distance_km(a: &Location, b: &Location) -> f64 {
    let (la1, lo1) = (a.latitude.to_radians(), a.longitude.to_radians());
    let (la2, lo2) = (b.latitude.to_radians(), b.longitude.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2)
        + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Whether `next` is different enough from `previous` to announce.
fn is_change(previous: Option<&Location>, next: &Location) -> bool {
    match previous {
        None => true,
        Some(previous) => {
            previous.source != next.source
                || previous.name != next.name
                || distance_km(previous, next) >= MIN_MOVE_KM
        }
    }
}

/// `get.geojs.io` answer: coordinates arrive as strings.
pub fn parse_network(body: &Value) -> Option<Location> {
    let number = |key: &str| -> Option<f64> {
        match body.get(key)? {
            Value::String(text) => text.trim().parse().ok(),
            Value::Number(number) => number.as_f64(),
            _ => None,
        }
    };
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let name = [text("city"), text("region")]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    Location::from_payload(&json!({
        "latitude": number("latitude")?,
        "longitude": number("longitude")?,
        "name": name,
        "country": text("country"),
        "timezone": text("timezone"),
        "source": "network",
        "accuracyKm": number("accuracy").unwrap_or(50.0),
    }))
}

#[derive(Default)]
struct State {
    city: String,
    current: Option<Location>,
    device: Option<(Location, Instant)>,
    /// Last network answer, kept for its place name.
    network: Option<Location>,
    started: bool,
}

pub struct LocationPlugin {
    http: reqwest::Client,
    publisher: Publisher,
    state: Mutex<State>,
}

static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();

impl LocationPlugin {
    pub fn new(http: reqwest::Client, publisher: Publisher) -> Self {
        LocationPlugin {
            http,
            publisher,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("location poisoned")
    }

    /// Adopt `next` and announce it when it differs from what is known.
    fn adopt(&self, next: Location) {
        let changed = {
            let mut state = self.lock();
            let changed = is_change(state.current.as_ref(), &next);
            state.current = Some(next.clone());
            changed
        };
        if changed {
            self.publisher.publish(
                TOPIC_CHANGED,
                serde_json::to_value(&next).unwrap_or(Value::Null),
            );
        }
    }

    /// Find the best location now, from the most trusted source available.
    async fn resolve(&self) -> Result<Location> {
        let (city, device) = {
            let state = self.lock();
            (state.city.clone(), state.device.clone())
        };
        let location = if !city.is_empty() {
            geocode(&self.http, &city).await?
        } else if let Some((fix, at)) = device.filter(|(_, at)| at.elapsed() < DEVICE_FIX_TTL) {
            let _ = at;
            self.named(fix)
        } else {
            let body: Value = self
                .http
                .get("https://get.geojs.io/v1/ip/geo.json")
                .timeout(Duration::from_secs(10))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let found = parse_network(&body).ok_or_else(|| {
                AppError::Tool("the network location service gave no position".to_string())
            })?;
            self.lock().network = Some(found.clone());
            found
        };
        self.adopt(location.clone());
        Ok(location)
    }

    /// A device fix has coordinates only; borrow a nearby place name.
    fn named(&self, mut fix: Location) -> Location {
        if fix.name.is_empty() {
            if let Some(network) = self.lock().network.clone() {
                if distance_km(&network, &fix) <= NAME_RADIUS_KM {
                    fix.name = network.name;
                    fix.country = network.country;
                    fix.timezone = network.timezone;
                }
            }
        }
        fix
    }

    async fn run(&self, tool: &str, args: &Value) -> Result<Value> {
        match tool {
            "location_current" => {
                let known = self.lock().current.clone();
                let location = match known {
                    Some(location) => location,
                    None => self.resolve().await?,
                };
                Ok(json!({
                    "summary": format!("location: {} (from {})", location.label(), location.source),
                    "location": location,
                }))
            }
            "location_refresh" => {
                let location = self.resolve().await?;
                Ok(json!({
                    "summary": format!("location updated: {} (from {})", location.label(), location.source),
                    "location": location,
                }))
            }
            "location_report" => {
                let latitude = args.get("latitude").and_then(Value::as_f64);
                let longitude = args.get("longitude").and_then(Value::as_f64);
                let accuracy_m = args
                    .get("accuracy")
                    .and_then(Value::as_f64)
                    .unwrap_or(1000.0);
                let fix = Location::from_payload(&json!({
                    "latitude": latitude,
                    "longitude": longitude,
                    "source": "device",
                    "accuracyKm": (accuracy_m / 1000.0).max(0.01),
                }))
                .ok_or_else(|| {
                    AppError::Tool("a device fix needs a valid latitude and longitude".to_string())
                })?;
                let manual = {
                    let mut state = self.lock();
                    state.device = Some((fix.clone(), Instant::now()));
                    !state.city.is_empty()
                };
                // A typed city wins; the fix is kept for when it is cleared.
                let location = if manual {
                    self.lock().current.clone().unwrap_or(fix)
                } else {
                    let named = self.named(fix);
                    self.adopt(named.clone());
                    named
                };
                Ok(json!({ "location": location }))
            }
            other => Err(AppError::other(format!("location cannot run {other}"))),
        }
    }
}

async fn geocode(http: &reqwest::Client, city: &str) -> Result<Location> {
    let body: Value = http
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city), ("count", "1"), ("format", "json")])
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let place = body
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
        .ok_or_else(|| AppError::Tool(format!("could not find a place called \"{city}\"")))?;
    let text = |key: &str| place.get(key).and_then(Value::as_str).unwrap_or_default();
    Location::from_payload(&json!({
        "latitude": place.get("latitude").and_then(Value::as_f64),
        "longitude": place.get("longitude").and_then(Value::as_f64),
        "name": if text("name").is_empty() { city } else { text("name") },
        "country": text("country"),
        "timezone": text("timezone"),
        "source": "manual",
        "accuracyKm": 5.0,
    }))
    .ok_or_else(|| AppError::Tool(format!("no coordinates for \"{city}\"")))
}

fn manifest() -> PluginManifest {
    PluginManifest::new(PLUGIN_ID, "Location", "1.0.0").with_capabilities(&[
        "location:device",
        "http:get.geojs.io",
        "http:geocoding-api.open-meteo.com",
        "publish:location.changed",
    ])
}

pub fn commands() -> Vec<CommandDescriptor> {
    vec![CommandDescriptor {
        name: "location.where".to_string(),
        scope: CommandScope::Tool,
        tool: Some("location_current".to_string()),
        descriptions: vec![
            (
                "en".to_string(),
                "Say where LILO thinks you are.".to_string(),
            ),
            (
                "pt".to_string(),
                "Diz onde o LILO acha que você está.".to_string(),
            ),
            (
                "it".to_string(),
                "Dice dove LILO pensa che tu sia.".to_string(),
            ),
        ],
        requires_confirm: false,
        templates: vec![
            ("en".to_string(), "where am i".to_string()),
            ("en".to_string(), "where do you think i am".to_string()),
            (
                "pt".to_string(),
                "onde (eu estou|estou|eu to|to)".to_string(),
            ),
            ("pt".to_string(), "qual [e] a minha localizacao".to_string()),
            ("it".to_string(), "dove (sono|mi trovo|sto)".to_string()),
            (
                "it".to_string(),
                "qual [e] la mia (posizione|localita)".to_string(),
            ),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    }]
}

impl ToolProvider for LocationPlugin {
    fn manifest(&self) -> &PluginManifest {
        MANIFEST.get_or_init(manifest)
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        let empty = json!({ "type": "object", "properties": {}, "required": [] });
        vec![
            ToolDescriptor {
                name: "location_current".to_string(),
                description: "The user's current location, resolving it if unknown.".to_string(),
                parameters: empty.clone(),
            },
            ToolDescriptor {
                name: "location_refresh".to_string(),
                description: "Resolve the location again from the best source.".to_string(),
                parameters: empty,
            },
            ToolDescriptor {
                name: "location_report".to_string(),
                description: "A position from the device's location service.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "latitude": { "type": "number" },
                        "longitude": { "type": "number" },
                        "accuracy": { "type": "number", "description": "Metres." }
                    },
                    "required": ["latitude", "longitude"]
                }),
            },
        ]
    }

    fn handles(&self, tool: &str) -> bool {
        matches!(
            tool,
            "location_current" | "location_refresh" | "location_report"
        )
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.run(tool, args))
    }

    fn ui(&self) -> PluginUi {
        let current = self.lock().current.clone();
        PluginUi {
            localized: Default::default(),
            settings: vec![SettingField {
                key: "city".to_string(),
                kind: FieldKind::Text,
                label: "City".to_string(),
                help: Some(
                    "Optional. Leave empty to use this device's location, or the network's when the device cannot tell."
                        .to_string(),
                ),
                placeholder: Some("Automatic".to_string()),
                options: Vec::new(),
                min: None,
                max: None,
                default: None,
            }],
            status: vec![StatusRow {
                label: "Location".to_string(),
                value: match &current {
                    Some(location) => format!("{} · {}", location.label(), location.source),
                    None => "Not known yet".to_string(),
                },
                state: Some(if current.is_some() { "ok" } else { "warn" }.to_string()),
            }],
            actions: vec![UiAction {
                label: "Update location".to_string(),
                tool: "location_refresh".to_string(),
                args: Value::Null, requires_confirm: false,
            }],
            scene: None,
            list: None,
            lists: Vec::new(), cards: Vec::new(), progress: Vec::new(), forms: Vec::new(),
        }
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let city = settings
                .get("city")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let (changed, started) = {
                let mut state = self.lock();
                let changed = state.city != city;
                state.city = city;
                (changed, state.started)
            };
            // At startup `start` resolves; afterwards a changed city applies now.
            if changed && started {
                self.resolve().await?;
            }
            Ok(())
        })
    }

    fn start<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.lock().started = true;
            let _ = self.resolve().await;
        })
    }

    fn prompt(&self) -> Option<String> {
        Some(
            "Knows the user's approximate location (city or region), which other abilities such \
             as weather use, and can say where it thinks the user is."
                .to_string(),
        )
    }

    fn commands(&self) -> Vec<CommandDescriptor> {
        commands()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::EventBus;

    fn plugin() -> (
        LocationPlugin,
        tokio::sync::mpsc::UnboundedReceiver<crate::plugins::Event>,
    ) {
        let (bus, receiver) = EventBus::new();
        (
            LocationPlugin::new(reqwest::Client::new(), bus.publisher(PLUGIN_ID)),
            receiver,
        )
    }

    #[test]
    fn a_network_answer_parses_with_string_coordinates() {
        let body = json!({
            "accuracy": 200, "country": "Italy", "latitude": "41.8905",
            "longitude": "12.5127", "region": "Lazio", "timezone": "Europe/Rome"
        });
        let location = parse_network(&body).unwrap();
        assert_eq!(location.name, "Lazio");
        assert_eq!(location.source, "network");
        assert!((location.latitude - 41.8905).abs() < 1e-6);
        assert!(parse_network(&json!({ "latitude": "x" })).is_none());
    }

    #[test]
    fn distances_and_changes() {
        let rome = Location::from_payload(
            &json!({ "latitude": 41.89, "longitude": 12.51, "source": "network" }),
        )
        .unwrap();
        let zurich = Location::from_payload(
            &json!({ "latitude": 47.37, "longitude": 8.54, "source": "network" }),
        )
        .unwrap();
        let km = distance_km(&rome, &zurich);
        assert!(km > 680.0 && km < 700.0, "{km}");
        assert!(!is_change(Some(&rome), &rome.clone()));
        assert!(is_change(Some(&rome), &zurich));
        assert!(Location::from_payload(
            &json!({ "latitude": 200.0, "longitude": 0.0, "source": "x" })
        )
        .is_none());
    }

    #[tokio::test]
    async fn a_device_fix_is_published_once_and_keeps_a_nearby_name() {
        let (plugin, mut events) = plugin();
        plugin.lock().network = Some(
            Location::from_payload(&json!({
                "latitude": 41.89, "longitude": 12.51, "name": "Lazio",
                "country": "Italy", "source": "network"
            }))
            .unwrap(),
        );
        let report = json!({ "latitude": 41.9, "longitude": 12.5, "accuracy": 30.0 });
        let result = plugin.invoke("location_report", &report).await.unwrap();
        assert_eq!(result["location"]["name"], "Lazio");
        assert_eq!(result["location"]["source"], "device");

        let event = events.try_recv().expect("the fix is announced");
        assert_eq!(event.topic, TOPIC_CHANGED);
        assert_eq!(event.source, PLUGIN_ID);

        // The same fix again is not news.
        plugin.invoke("location_report", &report).await.unwrap();
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_typed_city_is_not_overridden_by_the_device() {
        let (plugin, mut events) = plugin();
        {
            let mut state = plugin.lock();
            state.city = "Zurich".to_string();
            state.current = Location::from_payload(&json!({
                "latitude": 47.37, "longitude": 8.54, "name": "Zurich", "source": "manual"
            }));
        }
        let result = plugin
            .invoke(
                "location_report",
                &json!({ "latitude": 41.9, "longitude": 12.5 }),
            )
            .await
            .unwrap();
        assert_eq!(result["location"]["name"], "Zurich");
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn its_commands_and_ui_are_valid() {
        let (plugin, _events) = plugin();
        assert!(plugin.ui().validate().is_ok());
        let mut router = crate::commands::router::Router::new("lilo");
        router
            .register_plugin_commands(PLUGIN_ID, commands())
            .unwrap();
        let intent = router.registry().match_utterance("onde eu estou").unwrap();
        assert_eq!(intent.command, "location.where");
        for phrase in [
            "dove sono",
            "dove mi trovo",
            "qual è la mia posizione",
            "qual è la mia località",
        ] {
            assert_eq!(
                router.registry().match_utterance(phrase).map(|i| i.command),
                Some("location.where".to_string()),
                "{phrase}"
            );
        }
    }

    #[test]
    fn a_regional_tag_compiles_the_italian_commands() {
        // "it-IT" must behave exactly like "it": the Italian phrases compile,
        // English ones are filtered out, and the description is Italian.
        let mut registry =
            crate::commands::registry::Registry::with_locales("lilo", &["it-IT".to_string()]);
        registry.register(commands()).unwrap();
        assert_eq!(
            registry.match_utterance("dove mi trovo").map(|i| i.command),
            Some("location.where".to_string())
        );
        assert!(
            registry.match_utterance("where am i").is_none(),
            "a tag must still restrict matching to its own locale"
        );
        let description = registry
            .manifest_in("it-IT")
            .into_iter()
            .find(|entry| entry.name == "location.where")
            .map(|entry| entry.description)
            .unwrap();
        assert!(description.contains("LILO pensa"), "{description}");
    }

    ///   cargo test -p lilo-core -- --ignored network_location
    #[tokio::test]
    #[ignore = "network"]
    async fn network_location_resolves() {
        let (plugin, mut events) = plugin();
        let location = plugin.resolve().await.unwrap();
        eprintln!("{location:?}");
        assert_eq!(location.source, "network");
        assert!(events.try_recv().is_ok());
    }
}
