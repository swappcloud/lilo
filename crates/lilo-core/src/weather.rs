//! Weather: the local weather as a live background scene, and a mood on request.
//!
//! A first-party plugin: it goes through the same `ToolProvider` contract as a
//! marketplace plugin (tools, voice commands, settings, prompt, scene), but runs
//! in-process, so it works unchanged on the desktop and on a headless board.
//!
//! Data comes from Open-Meteo: free and keyless. Where to look comes from the
//! location plugin's `location.changed` event; a city typed in the settings
//! overrides it.
//!
//! The scene is a small fixed vocabulary the host knows how to draw. A plugin
//! never ships drawing code; it only says which scene and how strong.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::registry::{CommandDescriptor, CommandScope};
use crate::error::{AppError, Result};
use crate::plugins::ui::{FieldKind, SceneSource, SelectOption, SettingField, StatusRow, UiAction};
use crate::plugins::{BoxFuture, PluginManifest, PluginUi, ToolProvider};
use crate::tools::ToolDescriptor;

pub const PLUGIN_ID: &str = "lilo.weather";

/// Live weather is re-fetched at most this often; the host polls the scene far
/// more frequently and gets the cached value.
const REFRESH_EVERY: Duration = Duration::from_secs(15 * 60);
/// How often the host asks for the scene.
const SCENE_POLL_SECS: u64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SceneKind {
    None,
    Clear,
    Sun,
    Clouds,
    Fog,
    Rain,
    Snow,
    Storm,
    Heat,
    Cold,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub kind: SceneKind,
    /// 0..1.
    pub intensity: f32,
    pub night: bool,
}

impl Scene {
    fn new(kind: SceneKind, intensity: f32, night: bool) -> Self {
        Scene {
            kind,
            intensity: intensity.clamp(0.0, 1.0),
            night,
        }
    }

    fn none() -> Self {
        Scene::new(SceneKind::None, 0.0, false)
    }
}

/// WMO weather code (Open-Meteo `weather_code`) plus temperature to a scene.
///
/// A clear sky is where temperature matters: a hot clear day reads as heat and
/// a freezing one as cold, which is what the weather *feels* like.
pub fn scene_for(code: u32, temperature_c: f64, is_day: bool) -> Scene {
    let night = !is_day;
    let (kind, intensity) = match code {
        0 | 1 => {
            if is_day && temperature_c >= 28.0 {
                (SceneKind::Heat, ((temperature_c - 24.0) / 14.0) as f32)
            } else if temperature_c <= 2.0 {
                (SceneKind::Cold, ((6.0 - temperature_c) / 16.0) as f32)
            } else if is_day {
                (SceneKind::Sun, if code == 0 { 0.8 } else { 0.6 })
            } else {
                (SceneKind::Clear, 0.7)
            }
        }
        2 => (SceneKind::Clouds, 0.4),
        3 => (SceneKind::Clouds, 0.8),
        45 | 48 => (SceneKind::Fog, 0.7),
        51 | 53 | 55 | 56 | 57 => (SceneKind::Rain, 0.3),
        61 | 80 => (SceneKind::Rain, 0.45),
        63 | 66 | 81 => (SceneKind::Rain, 0.65),
        65 | 67 | 82 => (SceneKind::Rain, 0.9),
        71 | 77 | 85 => (SceneKind::Snow, 0.45),
        73 => (SceneKind::Snow, 0.65),
        75 | 86 => (SceneKind::Snow, 0.9),
        95 => (SceneKind::Storm, 0.7),
        96 | 99 => (SceneKind::Storm, 1.0),
        _ => (SceneKind::Clouds, 0.3),
    };
    Scene::new(kind, intensity.max(0.25), night)
}

/// Plain-English condition for the model's note.
pub fn condition_text(code: u32) -> &'static str {
    match code {
        0 => "clear sky",
        1 => "mainly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "fog",
        51 | 53 | 55 => "drizzle",
        56 | 57 => "freezing drizzle",
        61 | 63 => "rain",
        65 => "heavy rain",
        66 | 67 => "freezing rain",
        71 | 73 => "snow",
        75 => "heavy snow",
        77 => "snow grains",
        80..=82 => "rain showers",
        85 | 86 => "snow showers",
        95 => "thunderstorm",
        96 | 99 => "thunderstorm with hail",
        _ => "unsettled weather",
    }
}

/// The feeling that answers this one: cold asks for warmth, rain for sun.
pub fn opposite(scene: Scene) -> Scene {
    let kind = match scene.kind {
        SceneKind::Rain
        | SceneKind::Storm
        | SceneKind::Clouds
        | SceneKind::Fog
        | SceneKind::None => SceneKind::Sun,
        SceneKind::Snow | SceneKind::Cold => SceneKind::Heat,
        SceneKind::Heat => SceneKind::Cold,
        SceneKind::Sun | SceneKind::Clear => SceneKind::Rain,
    };
    Scene::new(kind, 0.75, false)
}

/// What a spoken mood asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mood {
    Scene(SceneKind),
    Opposite,
    Live,
}

const MOOD_WORDS: &[(&[&str], Mood)] = &[
    (
        &[
            "opposite",
            "contrary",
            "reverse",
            "oposto",
            "contrario",
            "inverso",
            "inverte",
            "opposto",
            "invertito",
            "rovescio",
        ],
        Mood::Opposite,
    ),
    (
        &[
            "real",
            "actual",
            "outside",
            "current",
            "verdadeiro",
            "atual",
            "lado",
            "fora",
            "reale",
            "vero",
            "attuale",
            "fuori",
        ],
        Mood::Live,
    ),
    (
        &[
            "off", "none", "nothing", "desliga", "desligar", "nenhum", "nada", "spento", "spenta",
            "niente", "nulla",
        ],
        Mood::Scene(SceneKind::None),
    ),
    (
        &[
            "storm",
            "stormy",
            "thunder",
            "thunderstorm",
            "lightning",
            "tempestade",
            "trovoada",
            "temporal",
            "raios",
            "temporale",
            "tempesta",
            "tuoni",
            "fulmini",
        ],
        Mood::Scene(SceneKind::Storm),
    ),
    (
        &[
            "rain",
            "rainy",
            "raining",
            "drizzle",
            "chuva",
            "chuvoso",
            "chovendo",
            "chover",
            "garoa",
            "pioggia",
            "piovoso",
            "piovendo",
            "piove",
            "pioggerella",
        ],
        Mood::Scene(SceneKind::Rain),
    ),
    (
        &[
            "snow",
            "snowy",
            "snowing",
            "neve",
            "nevando",
            "nevar",
            "nevica",
            "nevicando",
            "nevicata",
        ],
        Mood::Scene(SceneKind::Snow),
    ),
    (
        &[
            "warm",
            "hot",
            "heat",
            "summer",
            "calor",
            "quente",
            "verao",
            "calorzinho",
            "caldo",
            "calore",
            "estate",
            "afa",
            "afoso",
        ],
        Mood::Scene(SceneKind::Heat),
    ),
    (
        &[
            "cold",
            "chilly",
            "freezing",
            "winter",
            "frio",
            "gelado",
            "inverno",
            "friozinho",
            "freddo",
            "gelido",
            "gelo",
            "freddino",
        ],
        Mood::Scene(SceneKind::Cold),
    ),
    (
        &[
            "sun",
            "sunny",
            "sunshine",
            "sol",
            "ensolarado",
            "solzinho",
            "sole",
            "soleggiato",
            "assolato",
        ],
        Mood::Scene(SceneKind::Sun),
    ),
    (
        &[
            "fog", "foggy", "mist", "misty", "neblina", "nevoa", "cerracao", "nebbia", "foschia",
            "nebbioso",
        ],
        Mood::Scene(SceneKind::Fog),
    ),
    (
        &[
            "cloud", "clouds", "cloudy", "overcast", "nuvem", "nuvens", "nublado", "nuvola",
            "nuvole", "nuvoloso", "coperto",
        ],
        Mood::Scene(SceneKind::Clouds),
    ),
    (
        &[
            "clear",
            "stars",
            "starry",
            "night",
            "limpo",
            "estrelas",
            "estrelado",
            "noite",
            "sereno",
            "stelle",
            "stellato",
            "notte",
            "limpido",
        ],
        Mood::Scene(SceneKind::Clear),
    ),
];

/// Every word that names a mood, for the command's slot constraint.
pub fn mood_words() -> Vec<String> {
    MOOD_WORDS
        .iter()
        .flat_map(|(words, _)| words.iter().map(|word| word.to_string()))
        .collect()
}

/// Read a mood from free text, English or Portuguese. The first word that
/// names one wins, so "make it rain a lot" is rain.
pub fn parse_mood(text: &str) -> Option<Mood> {
    for token in crate::commands::matcher::tokenize(text) {
        for (words, mood) in MOOD_WORDS {
            if words.contains(&token.as_str()) {
                return Some(*mood);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Default)]
struct Config {
    city: String,
    fahrenheit: bool,
    effects: bool,
    /// Chosen background effect: `auto` follows the real weather, anything else
    /// is one of the scene kinds. The settings page uses it as a preview.
    effect: String,
}

impl Config {
    fn from_value(value: &Value) -> Self {
        Config {
            city: value
                .get("city")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            fahrenheit: value.get("units").and_then(Value::as_str) == Some("fahrenheit"),
            effects: value
                .get("effects")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            effect: value
                .get("effect")
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .trim()
                .to_lowercase(),
        }
    }
}

/// The scene a chosen effect asks for; `None` means "follow the real weather".
fn mood_for_effect(effect: &str) -> Option<Scene> {
    let kind = match effect.trim().to_lowercase().as_str() {
        "" | "auto" | "live" => return None,
        "off" | "none" => SceneKind::None,
        "clear" => SceneKind::Clear,
        "sun" | "sunny" => SceneKind::Sun,
        "clouds" | "cloudy" => SceneKind::Clouds,
        "fog" => SceneKind::Fog,
        "rain" => SceneKind::Rain,
        "snow" => SceneKind::Snow,
        "storm" => SceneKind::Storm,
        "heat" | "hot" | "warm" => SceneKind::Heat,
        "cold" => SceneKind::Cold,
        _ => return None,
    };
    Some(Scene::new(kind, 0.75, false))
}

#[derive(Debug, Clone)]
struct Report {
    city: String,
    country: String,
    temperature_c: f64,
    code: u32,
    scene: Scene,
    fetched: Instant,
    /// What this was fetched for (a city, or coordinates), so a change refetches.
    query: String,
}

#[derive(Default)]
struct State {
    config: Config,
    live: Option<Report>,
    mood: Option<Scene>,
    /// Last `location.changed` payload.
    location: Option<crate::location::Location>,
}

pub struct WeatherPlugin {
    http: reqwest::Client,
    state: Mutex<State>,
}

static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();

impl WeatherPlugin {
    pub fn new(http: reqwest::Client) -> Self {
        WeatherPlugin {
            http,
            state: Mutex::new(State {
                config: Config {
                    effects: true,
                    ..Config::default()
                },
                ..State::default()
            }),
        }
    }

    fn config(&self) -> Config {
        self.state.lock().expect("weather poisoned").config.clone()
    }

    /// Where to fetch for: the typed city, else the published location.
    fn target(&self) -> Option<Target> {
        let state = self.state.lock().expect("weather poisoned");
        if !state.config.city.is_empty() {
            return Some(Target::City(state.config.city.clone()));
        }
        state.location.clone().map(Target::Coordinates)
    }

    /// Fresh-enough live weather, fetching when stale or when the place changed.
    async fn live(&self, force: bool) -> Result<Report> {
        let target = self.target().ok_or_else(|| {
            AppError::Tool(
                "no location yet — allow location access, or set a city in the Weather settings"
                    .to_string(),
            )
        })?;
        let query = target.key();
        if !force {
            let cached = self.state.lock().expect("weather poisoned").live.clone();
            if let Some(report) = cached {
                if report.query == query && report.fetched.elapsed() < REFRESH_EVERY {
                    return Ok(report);
                }
            }
        }
        let report = match target {
            Target::City(city) => fetch(&self.http, &city).await?,
            Target::Coordinates(location) => {
                let forecast =
                    forecast_at(&self.http, location.latitude, location.longitude).await?;
                let place = json!({ "name": location.name, "country": location.country });
                parse_forecast(&place, &forecast, &query)?
            }
        };
        self.state.lock().expect("weather poisoned").live = Some(report.clone());
        Ok(report)
    }

    fn temperature_text(&self, report: &Report) -> String {
        if self.config().fahrenheit {
            format!("{:.0}°F", report.temperature_c * 9.0 / 5.0 + 32.0)
        } else {
            format!("{:.0}°C", report.temperature_c)
        }
    }

    /// What the background shows now.
    async fn current_scene(&self) -> Scene {
        if !self.config().effects {
            return Scene::none();
        }
        if let Some(mood) = self.state.lock().expect("weather poisoned").mood {
            return mood;
        }
        match self.live(false).await {
            Ok(report) => report.scene,
            Err(_) => Scene::none(),
        }
    }

    async fn run(&self, tool: &str, args: &Value) -> Result<Value> {
        match tool {
            "weather_scene" => Ok(json!({ "scene": self.current_scene().await })),
            "weather_now" => {
                let report = self.live(true).await?;
                let place = if report.city.is_empty() {
                    "your area".to_string()
                } else {
                    report.city.clone()
                };
                let summary = format!(
                    "weather in {}: {}, {}",
                    place,
                    condition_text(report.code),
                    self.temperature_text(&report)
                );
                Ok(json!({
                    "summary": summary,
                    "city": report.city,
                    "country": report.country,
                    "temperatureC": report.temperature_c,
                    "condition": condition_text(report.code),
                    "scene": self.current_scene().await,
                }))
            }
            "weather_mood" => {
                let asked = args.get("mood").and_then(Value::as_str).unwrap_or_default();
                let mood = parse_mood(asked).ok_or_else(|| {
                    AppError::Tool(format!(
                        "\"{asked}\" is not a weather mood (try rain, snow, sun, storm, fog, clouds, warm, cold, or the opposite)"
                    ))
                })?;
                match mood {
                    Mood::Live => self.back_to_live().await,
                    Mood::Opposite => {
                        let base = match self.live(false).await {
                            Ok(report) => report.scene,
                            Err(_) => Scene::none(),
                        };
                        let scene = opposite(base);
                        self.set_mood(scene);
                        Ok(json!({
                            "summary": format!("background set to the opposite of the real weather: {}", kind_text(scene.kind)),
                            "scene": scene,
                        }))
                    }
                    Mood::Scene(kind) => {
                        let scene = Scene::new(kind, 0.75, false);
                        self.set_mood(scene);
                        let summary = if kind == SceneKind::None {
                            "background effect turned off".to_string()
                        } else {
                            format!("background set to {}", kind_text(kind))
                        };
                        Ok(json!({ "summary": summary, "scene": scene }))
                    }
                }
            }
            "weather_live" => self.back_to_live().await,
            other => Err(AppError::other(format!("weather cannot run {other}"))),
        }
    }

    async fn back_to_live(&self) -> Result<Value> {
        self.state.lock().expect("weather poisoned").mood = None;
        let scene = self.current_scene().await;
        Ok(json!({
            "summary": "background shows the real weather again",
            "scene": scene,
        }))
    }

    fn set_mood(&self, scene: Scene) {
        self.state.lock().expect("weather poisoned").mood = Some(scene);
    }
}

fn kind_text(kind: SceneKind) -> &'static str {
    match kind {
        SceneKind::None => "no effect",
        SceneKind::Clear => "a clear starry sky",
        SceneKind::Sun => "sunshine",
        SceneKind::Clouds => "clouds",
        SceneKind::Fog => "fog",
        SceneKind::Rain => "rain",
        SceneKind::Snow => "snow",
        SceneKind::Storm => "a storm",
        SceneKind::Heat => "summer heat",
        SceneKind::Cold => "winter cold",
    }
}

enum Target {
    City(String),
    Coordinates(crate::location::Location),
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::City(city) => city.clone(),
            // ~1 km grid: small moves reuse the cached report.
            Target::Coordinates(location) => {
                format!("{:.2},{:.2}", location.latitude, location.longitude)
            }
        }
    }
}

async fn forecast_at(http: &reqwest::Client, latitude: f64, longitude: f64) -> Result<Value> {
    Ok(http
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("current", "temperature_2m,weather_code,is_day".to_string()),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn fetch(http: &reqwest::Client, city: &str) -> Result<Report> {
    let geo: Value = http
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city), ("count", "1"), ("format", "json")])
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let place = geo
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
        .ok_or_else(|| AppError::Tool(format!("could not find a place called \"{city}\"")))?;
    let latitude = place
        .get("latitude")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let longitude = place
        .get("longitude")
        .and_then(Value::as_f64)
        .unwrap_or_default();

    let forecast = forecast_at(http, latitude, longitude).await?;
    parse_forecast(place, &forecast, city)
}

fn parse_forecast(place: &Value, forecast: &Value, query: &str) -> Result<Report> {
    let current = forecast.get("current").ok_or_else(|| {
        AppError::Tool("the weather service returned no current conditions".to_string())
    })?;
    let temperature_c = current
        .get("temperature_2m")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let code = current
        .get("weather_code")
        .and_then(Value::as_u64)
        .unwrap_or(3) as u32;
    let is_day = current.get("is_day").and_then(Value::as_u64).unwrap_or(1) == 1;
    Ok(Report {
        city: place
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        country: place
            .get("country")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        temperature_c,
        code,
        scene: scene_for(code, temperature_c, is_day),
        fetched: Instant::now(),
        query: query.to_string(),
    })
}

fn manifest() -> PluginManifest {
    PluginManifest::new(PLUGIN_ID, "Weather", "1.0.0").with_capabilities(&[
        "http:api.open-meteo.com",
        "http:geocoding-api.open-meteo.com",
    ])
}

fn command(
    name: &str,
    tool: &str,
    en: &str,
    pt: &str,
    it: &str,
    templates: &[(&str, &str)],
) -> CommandDescriptor {
    CommandDescriptor {
        name: name.to_string(),
        scope: CommandScope::Tool,
        tool: Some(tool.to_string()),
        descriptions: vec![
            ("en".to_string(), en.to_string()),
            ("pt".to_string(), pt.to_string()),
            ("it".to_string(), it.to_string()),
        ],
        requires_confirm: false,
        templates: templates
            .iter()
            .map(|(locale, template)| (locale.to_string(), template.to_string()))
            .collect(),
        slot_words: Vec::new(),
        args: Vec::new(),
    }
}

/// Voice commands. The mood phrases take free text that must contain a mood
/// word, and `weather_mood` reads it; broad phrases stay safe because anything
/// without a mood word is not this command.
pub fn commands() -> Vec<CommandDescriptor> {
    let mut mood = command(
        "weather.mood",
        "weather_mood",
        "Change the background mood: rain, snow, sun, storm, fog, clouds, warm, cold, or the opposite of the real weather.",
        "Muda o clima do fundo: chuva, neve, sol, tempestade, neblina, nuvens, calor, frio, ou o contrário do clima real.",
        "Cambia lo sfondo: pioggia, neve, sole, temporale, nebbia, nuvole, caldo, freddo, o il contrario del meteo reale.",
        &[
            ("en", "make it {mood}"),
            ("en", "i want to feel {mood}"),
            ("en", "i want (some|a) {mood}"),
            ("en", "(set|change) the (background|weather|mood) to {mood}"),
            ("en", "show me {mood}"),
            ("pt", "quero sentir {mood}"),
            ("pt", "(deixa|faz|coloca|bota) [o fundo|o clima] {mood}"),
            ("pt", "(muda|troca) [o fundo|o clima] (para|pra|pro) {mood}"),
            ("pt", "quero (um|uma|o|a) {mood}"),
            ("it", "voglio sentire {mood}"),
            ("it", "(metti|fai|imposta|manda) [lo sfondo|il clima] {mood}"),
            ("it", "(cambia|trasforma) [lo sfondo|il clima] (in|a|su) {mood}"),
            ("it", "voglio (un|una|il|la) {mood}"),
        ],
    );
    mood.slot_words = vec![("mood".to_string(), mood_words())];
    // "Turn the effect off" carries no free text, so the arg is fixed here.
    let mut off = command(
        "weather.off",
        "weather_mood",
        "Turn the background effect off.",
        "Desliga o efeito de fundo.",
        "Spegne l'effetto di sfondo.",
        &[
            ("en", "(turn|switch) off the (background|effect|effects|weather|scene)"),
            ("en", "(stop|remove|hide|disable) the (background|effect|effects|weather)"),
            ("en", "no (background|effect|effects)"),
            ("pt", "(desliga|desligar|desativa|desativar|para|parar|tira|tirar|remove|remover|esconde|esconder) [o|a] (fundo|efeito|clima|background)"),
            ("pt", "sem (fundo|efeito)"),
            ("it", "(spegni|spegnere|disattiva|disattivare|togli|togliere|rimuovi|rimuovere|nascondi|nascondere) [lo|la|l] (sfondo|effetto|clima|background|scena)"),
            ("it", "senza (sfondo|effetto)"),
        ],
    );
    off.args = vec![("mood".to_string(), "off".to_string())];
    vec![
        command(
            "weather.now",
            "weather_now",
            "Tell the current weather.",
            "Diz como está o tempo agora.",
            "Dice com'è il tempo adesso.",
            &[
                ("en", "how is the weather [today|now|outside]"),
                ("en", "what is the weather [like] [today|now|outside]"),
                ("en", "what s the weather [like] [today|now|outside]"),
                ("pt", "como (esta|ta) o (tempo|clima) [hoje|agora|la fora]"),
                ("pt", "qual [e] a previsao do tempo"),
                ("pt", "(esta|ta) (frio|calor|chovendo) [la fora|hoje]"),
                ("it", "come (e|sta) (il|lo) (tempo|clima) [oggi|adesso|fuori]"),
                ("it", "com'e (il|lo) (tempo|clima) [oggi|adesso|fuori]"),
                ("it", "che tempo fa"),
                ("it", "qual [e] (la|il) (previsione|previsioni|meteo)"),
                ("it", "(e|fa|sta) (freddo|caldo|fresco|piovendo) [fuori|oggi]"),
            ],
        ),
        command(
            "weather.live",
            "weather_live",
            "Show the real weather in the background again.",
            "Volta o fundo para o clima real.",
            "Rimette il meteo reale sullo sfondo.",
            &[
                ("en", "(show|back to) the real weather"),
                ("en", "back to the actual weather"),
                // Turning the effect back on after "turn off the background":
                // the real weather is what "on" means when no mood is named.
                ("en", "(turn|switch) [the] (background|effect|effects|weather|scene) [back] on"),
                ("en", "(turn|switch) [back] on the (background|effect|effects|weather|scene)"),
                ("en", "(enable|activate|restore|bring back) the (background|effect|effects|weather|scene)"),
                ("en", "show the (background|effect|weather) again"),
                ("pt", "(volta|voltar) [para|pro] [o] clima real"),
                ("pt", "mostra o clima (real|de verdade)"),
                ("pt", "(liga|ligar|ativa|ativar|restaura|restaurar|volta|voltar) [o|a] (fundo|efeito|clima|background)"),
                ("pt", "(traz|trazer) [de volta] [o|a] (fundo|efeito|clima|background)"),
                ("it", "(torna|ritorna) [al] (clima|meteo) (reale|vero)"),
                ("it", "mostra (il|lo) (clima|meteo) (reale|vero)"),
                ("it", "(accendi|accendere|attiva|attivare|ripristina|ripristinare|rimetti) [lo|la|l] (sfondo|effetto|clima|background|scena)"),
                ("it", "(riporta|riportare) [di nuovo] [lo|la|l] (sfondo|effetto|clima|background|scena)"),
            ],
        ),
        mood,
        off,
    ]
}

impl ToolProvider for WeatherPlugin {
    fn manifest(&self) -> &PluginManifest {
        MANIFEST.get_or_init(manifest)
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        let empty = json!({ "type": "object", "properties": {}, "required": [] });
        vec![
            ToolDescriptor {
                name: "weather_now".to_string(),
                description: "Fetch the current weather for the configured city.".to_string(),
                parameters: empty.clone(),
            },
            ToolDescriptor {
                name: "weather_scene".to_string(),
                description: "The background scene to draw right now.".to_string(),
                parameters: empty.clone(),
            },
            ToolDescriptor {
                name: "weather_mood".to_string(),
                description:
                    "Override the background with a mood, or the opposite of the real weather."
                        .to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "mood": { "type": "string", "description": "rain, snow, sun, storm, fog, clouds, warm, cold, clear, opposite, real, off" } },
                    "required": ["mood"]
                }),
            },
            ToolDescriptor {
                name: "weather_live".to_string(),
                description: "Drop the mood override and show the real weather.".to_string(),
                parameters: empty,
            },
        ]
    }

    fn handles(&self, tool: &str) -> bool {
        matches!(
            tool,
            "weather_now" | "weather_scene" | "weather_mood" | "weather_live"
        )
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.run(tool, args))
    }

    fn ui(&self) -> PluginUi {
        let config = self.config();
        // Read once: locking again while a guard is alive would deadlock.
        let location = self
            .state
            .lock()
            .expect("weather poisoned")
            .location
            .clone();
        let option = |value: &str, label: &str| SelectOption {
            value: value.to_string(),
            label: label.to_string(),
        };
        PluginUi {
            localized: Default::default(),
            settings: vec![
                SettingField {
                    key: "city".to_string(),
                    kind: FieldKind::Text,
                    label: "City".to_string(),
                    help: Some(
                        "Optional. Leave empty to follow your location from the Location plugin."
                            .to_string(),
                    ),
                    placeholder: Some("Automatic".to_string()),
                    options: Vec::new(),
                    min: None,
                    max: None,
                    default: None,
                },
                SettingField {
                    key: "units".to_string(),
                    kind: FieldKind::Select,
                    label: "Temperature".to_string(),
                    help: None,
                    placeholder: None,
                    options: vec![
                        option("celsius", "Celsius"),
                        option("fahrenheit", "Fahrenheit"),
                    ],
                    min: None,
                    max: None,
                    default: Some(json!("celsius")),
                },
                SettingField {
                    key: "effects".to_string(),
                    kind: FieldKind::Switch,
                    label: "Background effect".to_string(),
                    help: Some("Rain, snow, sun and more behind LILO.".to_string()),
                    placeholder: None,
                    options: Vec::new(),
                    min: None,
                    max: None,
                    default: Some(json!(true)),
                },
                SettingField {
                    key: "effect".to_string(),
                    kind: FieldKind::Select,
                    label: "Effect".to_string(),
                    help: Some(
                        "Preview any effect, or follow the real weather. A spoken mood \
                         (\"make it rain\") changes the same thing."
                            .to_string(),
                    ),
                    placeholder: None,
                    options: vec![
                        option("auto", "Follow the weather"),
                        option("sun", "Sunshine"),
                        option("clear", "Clear sky"),
                        option("clouds", "Clouds"),
                        option("fog", "Fog"),
                        option("rain", "Rain"),
                        option("snow", "Snow"),
                        option("storm", "Thunderstorm"),
                        option("heat", "Heat"),
                        option("cold", "Cold"),
                        option("none", "No effect"),
                    ],
                    min: None,
                    max: None,
                    default: Some(json!("auto")),
                },
            ],
            status: vec![StatusRow {
                label: "Location".to_string(),
                value: match (config.city.is_empty(), &location) {
                    (false, _) => format!("{} (typed)", config.city),
                    (true, Some(location)) if !location.name.is_empty() => location.name.clone(),
                    (true, Some(_)) => "Your area".to_string(),
                    (true, None) => "Waiting for a location".to_string(),
                },
                state: Some(
                    if config.city.is_empty() && location.is_none() {
                        "warn"
                    } else {
                        "ok"
                    }
                    .to_string(),
                ),
            }],
            actions: vec![
                UiAction {
                    label: "Update weather now".to_string(),
                    tool: "weather_now".to_string(),
                    args: Value::Null,
                    requires_confirm: false,
                },
                UiAction {
                    label: "Show the real weather".to_string(),
                    tool: "weather_live".to_string(),
                    args: Value::Null,
                    requires_confirm: false,
                },
            ],
            scene: Some(SceneSource {
                tool: "weather_scene".to_string(),
                every_secs: SCENE_POLL_SECS,
            }),
            list: None,
            lists: Vec::new(),
            cards: Vec::new(),
            progress: Vec::new(),
            forms: Vec::new(),
        }
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let config = Config::from_value(&settings);
            // The chosen effect *is* the mood override: one state, whether it
            // came from the settings page or from a spoken "make it rain".
            let mood = mood_for_effect(&config.effect);
            let mut state = self.state.lock().expect("weather poisoned");
            state.config = config;
            state.mood = mood;
            Ok(())
        })
    }

    fn prompt(&self) -> Option<String> {
        Some(
            "Shows the local weather as a live background behind LILO and can tell the current \
             weather. On request it changes the background mood — rain, snow, sun, storm, fog, \
             clouds, warmth, cold, or the opposite of the real weather — and can go back to the \
             real weather."
                .to_string(),
        )
    }

    fn commands(&self) -> Vec<CommandDescriptor> {
        commands()
    }

    fn subscriptions(&self) -> Vec<String> {
        vec![crate::location::TOPIC_CHANGED.to_string()]
    }

    fn on_event<'a>(&'a self, event: &'a crate::plugins::Event) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Some(location) = crate::location::Location::from_payload(&event.payload) {
                let mut state = self.state.lock().expect("weather poisoned");
                state.location = Some(location);
                // The next scene poll fetches for the new place.
                state.live = None;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_codes_become_scenes() {
        assert_eq!(scene_for(61, 15.0, true).kind, SceneKind::Rain);
        assert_eq!(scene_for(95, 20.0, true).kind, SceneKind::Storm);
        assert_eq!(scene_for(73, -3.0, true).kind, SceneKind::Snow);
        assert_eq!(scene_for(45, 8.0, false).kind, SceneKind::Fog);
        assert_eq!(scene_for(3, 12.0, true).kind, SceneKind::Clouds);
        assert!(scene_for(3, 12.0, false).night);
    }

    #[test]
    fn a_clear_sky_reads_by_temperature() {
        assert_eq!(scene_for(0, 33.0, true).kind, SceneKind::Heat);
        assert_eq!(scene_for(0, -4.0, true).kind, SceneKind::Cold);
        assert_eq!(scene_for(0, 18.0, true).kind, SceneKind::Sun);
        assert_eq!(scene_for(0, 18.0, false).kind, SceneKind::Clear);
    }

    #[test]
    fn moods_parse_in_every_language() {
        assert_eq!(parse_mood("rain"), Some(Mood::Scene(SceneKind::Rain)));
        assert_eq!(
            parse_mood("um calorzinho"),
            Some(Mood::Scene(SceneKind::Heat))
        );
        assert_eq!(
            parse_mood("like winter"),
            Some(Mood::Scene(SceneKind::Cold))
        );
        assert_eq!(parse_mood("o contrário"), Some(Mood::Opposite));
        assert_eq!(parse_mood("the real weather"), Some(Mood::Live));
        assert_eq!(parse_mood("neblina"), Some(Mood::Scene(SceneKind::Fog)));
        assert_eq!(parse_mood("pioggia"), Some(Mood::Scene(SceneKind::Rain)));
        assert_eq!(
            parse_mood("un po' di neve"),
            Some(Mood::Scene(SceneKind::Snow))
        );
        assert_eq!(parse_mood("il contrario"), Some(Mood::Opposite));
        assert_eq!(parse_mood("il meteo vero"), Some(Mood::Live));
        assert_eq!(parse_mood("banana"), None);
    }

    #[test]
    fn the_opposite_answers_the_feeling() {
        let cold = Scene::new(SceneKind::Cold, 0.8, false);
        assert_eq!(opposite(cold).kind, SceneKind::Heat);
        assert_eq!(
            opposite(Scene::new(SceneKind::Rain, 0.5, false)).kind,
            SceneKind::Sun
        );
        assert_eq!(
            opposite(Scene::new(SceneKind::Heat, 0.5, false)).kind,
            SceneKind::Cold
        );
    }

    #[tokio::test]
    async fn a_mood_overrides_the_scene_until_the_real_weather_returns() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        let result = plugin
            .invoke("weather_mood", &json!({ "mood": "neve" }))
            .await
            .unwrap();
        assert_eq!(result["scene"]["kind"], "snow");
        let scene = plugin.invoke("weather_scene", &json!({})).await.unwrap();
        assert_eq!(scene["scene"]["kind"], "snow");

        // No city configured: going back to live weather means no effect.
        let live = plugin.invoke("weather_live", &json!({})).await.unwrap();
        assert_eq!(live["scene"]["kind"], "none");
    }

    #[tokio::test]
    async fn effects_off_draws_nothing_even_with_a_mood() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        plugin
            .configure(json!({ "city": "", "effects": false }))
            .await
            .unwrap();
        plugin
            .invoke("weather_mood", &json!({ "mood": "storm" }))
            .await
            .unwrap();
        let scene = plugin.invoke("weather_scene", &json!({})).await.unwrap();
        assert_eq!(scene["scene"]["kind"], "none");
    }

    #[tokio::test]
    async fn it_follows_the_published_location_unless_a_city_is_typed() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        assert!(plugin.target().is_none());
        let event = crate::plugins::Event {
            topic: "location.changed".into(),
            payload: json!({ "latitude": 41.89, "longitude": 12.51, "name": "Lazio", "source": "network" }),
            source: "lilo.location".into(),
        };
        plugin.on_event(&event).await;
        assert!(matches!(plugin.target(), Some(Target::Coordinates(_))));
        assert_eq!(plugin.target().unwrap().key(), "41.89,12.51");
        plugin.configure(json!({ "city": "Zurich" })).await.unwrap();
        assert!(matches!(plugin.target(), Some(Target::City(city)) if city == "Zurich"));
    }

    #[test]
    fn a_forecast_payload_parses() {
        let place = json!({ "name": "Zurich", "country": "Switzerland", "latitude": 47.37, "longitude": 8.55 });
        let forecast =
            json!({ "current": { "temperature_2m": -1.5, "weather_code": 71, "is_day": 1 } });
        let report = parse_forecast(&place, &forecast, "zurich").unwrap();
        assert_eq!(report.city, "Zurich");
        assert_eq!(report.scene.kind, SceneKind::Snow);
    }

    #[test]
    fn its_commands_and_ui_are_valid() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        assert!(plugin.ui().validate().is_ok());
        let mut router = crate::commands::router::Router::new("lilo");
        router
            .register_plugin_commands(PLUGIN_ID, commands())
            .expect("weather commands must not clash with built-ins");
        let registry = router.registry();
        let intent = registry
            .match_utterance("make it rain")
            .expect("a mood matches");
        assert_eq!(intent.command, "weather.mood");
        assert_eq!(intent.args.get("mood").map(String::as_str), Some("rain"));
        let pt = registry
            .match_utterance("quero sentir um calorzinho")
            .expect("pt mood");
        assert_eq!(pt.command, "weather.mood");
        assert!(registry.match_utterance("make it louder").is_none());
        assert!(registry.match_utterance("quero uma pizza").is_none());
        assert_eq!(
            registry
                .match_utterance("como está o tempo hoje")
                .map(|i| i.command),
            Some("weather.now".to_string())
        );

        // A phrase with no free text still tells the tool what it means.
        let off = registry
            .match_utterance("turn off the background")
            .expect("off matches");
        assert_eq!(off.command, "weather.off");
        assert_eq!(off.args.get("mood").map(String::as_str), Some("off"));
        assert!(!off.has_slot, "nothing to wait for: it can fire at once");
        assert_eq!(
            registry
                .match_utterance("desliga o efeito")
                .map(|i| i.command),
            Some("weather.off".to_string())
        );
        assert!(registry.match_utterance("turn off the music").is_none());

        // Turning the effect back on: the real weather is what "on" means.
        for phrase in [
            "turn the background back on",
            "turn on the background",
            "enable the effect",
            "ativa o efeito",
            "liga o fundo",
            "volta o efeito",
            "back to the real weather",
            "torna al clima reale",
            "mostra il meteo reale",
            "accendi lo sfondo",
            "riporta lo sfondo",
        ] {
            assert_eq!(
                registry.match_utterance(phrase).map(|i| i.command),
                Some("weather.live".to_string()),
                "{phrase}"
            );
        }

        // Italian phrases and moods match the same commands.
        let it_mood = registry
            .match_utterance("voglio la pioggia")
            .expect("it mood");
        assert_eq!(it_mood.command, "weather.mood");
        assert_eq!(
            it_mood.args.get("mood").map(String::as_str),
            Some("pioggia")
        );
        let it_mood = registry
            .match_utterance("metti lo sfondo neve")
            .expect("it mood with a frame");
        assert_eq!(it_mood.command, "weather.mood");
        assert!(registry.match_utterance("voglio una pizza").is_none());
        assert!(registry.match_utterance("fammi vedere il sole").is_none());
        assert_eq!(
            registry
                .match_utterance("com'è il tempo")
                .map(|i| i.command),
            Some("weather.now".to_string())
        );
        assert_eq!(
            registry.match_utterance("che tempo fa").map(|i| i.command),
            Some("weather.now".to_string())
        );
        assert_eq!(
            registry
                .match_utterance("qual è la previsione")
                .map(|i| i.command),
            Some("weather.now".to_string())
        );
        let it_off = registry
            .match_utterance("spegni lo sfondo")
            .expect("it off");
        assert_eq!(it_off.command, "weather.off");
        assert_eq!(it_off.args.get("mood").map(String::as_str), Some("off"));
        assert!(!it_off.has_slot, "nothing to wait for: it can fire at once");
        assert_eq!(
            registry.match_utterance("senza effetto").map(|i| i.command),
            Some("weather.off".to_string())
        );
        assert_ne!(
            registry
                .match_utterance("spegni la musica")
                .map(|i| i.command),
            Some("weather.off".to_string()),
            "a media phrase must not turn the background off"
        );
    }

    #[test]
    fn a_regional_tag_compiles_the_italian_commands() {
        // An active "it-IT" locale must behave exactly like "it": Italian
        // phrases compile, English ones are filtered out, and the help panel is
        // written in Italian.
        let mut registry =
            crate::commands::registry::Registry::with_locales("lilo", &["it-IT".to_string()]);
        registry.register(commands()).unwrap();
        assert_eq!(
            registry
                .match_utterance("voglio la pioggia")
                .map(|i| i.command),
            Some("weather.mood".to_string())
        );
        assert!(
            registry.match_utterance("make it rain").is_none(),
            "a tag must still restrict matching to its own locale"
        );
        let description = registry
            .manifest_in("it-IT")
            .into_iter()
            .find(|entry| entry.name == "weather.mood")
            .map(|entry| entry.description)
            .unwrap();
        assert!(description.contains("Cambia lo sfondo"), "{description}");
    }

    /// Real network call.
    ///   cargo test -p lilo-core -- --ignored live_weather
    #[tokio::test]
    #[ignore = "network"]
    async fn live_weather_for_a_real_city() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        plugin.configure(json!({ "city": "Zurich" })).await.unwrap();
        let now = plugin.invoke("weather_now", &json!({})).await.unwrap();
        eprintln!("{now}");
        assert!(now["summary"].as_str().unwrap().contains("Zurich"));
    }

    #[test]
    fn a_chosen_effect_names_a_scene() {
        assert!(
            mood_for_effect("auto").is_none(),
            "auto follows the weather"
        );
        assert!(mood_for_effect("").is_none());
        assert_eq!(mood_for_effect("storm").unwrap().kind, SceneKind::Storm);
        assert_eq!(mood_for_effect("  RAIN ").unwrap().kind, SceneKind::Rain);
        assert_eq!(mood_for_effect("none").unwrap().kind, SceneKind::None);
        assert!(mood_for_effect("banana").is_none());
    }

    #[tokio::test]
    async fn the_effect_setting_previews_a_scene() {
        let plugin = WeatherPlugin::new(reqwest::Client::new());
        // Picking an effect is the same state a spoken mood sets.
        plugin.configure(json!({ "effect": "snow" })).await.unwrap();
        assert_eq!(plugin.current_scene().await.kind, SceneKind::Snow);

        // Back to auto: with no city and no location there is nothing to show,
        // which is the honest answer without a network round trip.
        plugin.configure(json!({ "effect": "auto" })).await.unwrap();
        assert_eq!(plugin.current_scene().await.kind, SceneKind::None);

        // The switch still wins over the chosen effect.
        plugin
            .configure(json!({ "effect": "snow", "effects": false }))
            .await
            .unwrap();
        assert_eq!(plugin.current_scene().await.kind, SceneKind::None);
    }
}
