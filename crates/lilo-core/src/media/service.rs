//! The media facade the command router talks to.
//!
//! Everything above this line is provider-agnostic: the router only ever emits
//! a tool name and JSON args. Swapping YouTube for Spotify later means another
//! `Resolver` variant and, at most, another `Player` — nothing in the command
//! layer changes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::plugins::bus::Publisher;
use crate::plugins::{BoxFuture, PluginManifest, ToolProvider};
use crate::settings::MediaSettings;
use crate::tools::ToolDescriptor;

use super::binaries;
use super::player::{MpvPlayer, NowPlaying};
use super::provision::{self, ToolStatus};
use super::resolver::{Query, Resolver, Track};

/// How many related songs to queue at a time: about an hour and a half of
/// music, and one yt-dlp call.
const RELATED_LIMIT: usize = 20;

/// Published on the plugin bus each time a new track starts, whatever
/// started it: a voice command, a button, or mpv moving down the queue.
pub const TOPIC_PLAYING: &str = "media.playing";

/// How often the watcher checks which track mpv is on. It asks mpv only while
/// a player is running; an idle app does no work.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// Tools this service answers to. Kept next to the implementation so the
/// registry, the descriptors and the dispatch cannot drift apart.
pub const TOOL_NAMES: &[&str] = &[
    "media_search",
    "media_play",
    "media_radio",
    "media_pause",
    "media_resume",
    "media_stop",
    "media_next",
    "media_previous",
    "media_volume",
    "media_status",
    "media_duck",
    "media_install_deps",
];

pub fn handles(tool: &str) -> bool {
    TOOL_NAMES.contains(&tool)
}

/// Media controls that take no arguments — the shape repeats often enough that
/// spelling out an empty schema seven times only invites drift.
fn simple_tool(name: &str, description: &str) -> ToolDescriptor {
    ToolDescriptor {
        name: name.to_string(),
        description: description.to_string(),
        parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
    }
}

/// The tool schemas the settings UI and the model prompt are built from.
pub fn descriptors() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            name: "media_search".to_string(),
            description: "Search for songs and return selectable YouTube results.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Song title or artist." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }),
        },
        ToolDescriptor {
            name: "media_play".to_string(),
            description:
                "Play music. Give a track, an artist, or both; LILO resolves and plays it locally."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "track": { "type": "string", "description": "Song title." },
                    "artist": { "type": "string", "description": "Artist name." },
                    "trackId": { "type": "string", "description": "Exact YouTube video ID from media_search." },
                    "limit": {
                        "type": "integer",
                        "description": "How many tracks to queue (1-25).",
                        "minimum": 1,
                        "maximum": 25
                    }
                },
                "required": []
            }),
        },
        ToolDescriptor {
            name: "media_radio".to_string(),
            description: "Keep playing songs related to what is playing now, like YouTube's \
autoplay. Give a track or artist to start from that song instead."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "track": { "type": "string", "description": "Song to start from." },
                    "artist": { "type": "string", "description": "Artist to start from." }
                },
                "required": []
            }),
        },
        simple_tool("media_pause", "Pause playback."),
        simple_tool("media_resume", "Resume playback."),
        simple_tool("media_stop", "Stop playback and clear the queue."),
        simple_tool("media_next", "Skip to the next track."),
        simple_tool("media_previous", "Go back to the previous track."),
        ToolDescriptor {
            name: "media_volume".to_string(),
            description: "Set playback volume (0-100). Accepts digits or spoken numbers."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "level": { "type": "string", "description": "Volume, e.g. \"30\" or \"trinta\"." }
                },
                "required": ["level"]
            }),
        },
        ToolDescriptor {
            name: "media_duck".to_string(),
            description: "Lower the music while the assistant is speaking, then restore it."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "on": { "type": "boolean", "description": "True to duck, false to restore." }
                },
                "required": ["on"]
            }),
        },
        simple_tool(
            "media_status",
            "Report what is playing and which media binaries exist.",
        ),
        simple_tool(
            "media_install_deps",
            "Download the media binaries LILO needs, verifying their checksums.",
        ),
    ]
}

/// Identity and declared permissions. This is the shape a marketplace plugin
/// will fill in: what it is, and what it is allowed to touch.
fn manifest() -> PluginManifest {
    PluginManifest::new("core.media", "Media playback", env!("CARGO_PKG_VERSION"))
        .with_hosts(&["desktop", "daemon"])
        .with_capabilities(&[
            "exec:mpv",
            "exec:yt-dlp",
            "http:pipedapi",
            "audio:out",
            "storage:media",
        ])
}

static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();

impl ToolProvider for MediaService {
    fn manifest(&self) -> &PluginManifest {
        MANIFEST.get_or_init(manifest)
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        descriptors()
    }

    fn handles(&self, tool: &str) -> bool {
        handles(tool)
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move { self.run_tool(tool, args).await })
    }

    fn set_publisher(&self, publisher: Publisher) {
        *self.publisher.lock().expect("publisher poisoned") = Some(publisher);
    }

    fn start<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            loop {
                tokio::time::sleep(WATCH_EVERY).await;
                self.announce_track();
            }
        })
    }
}

/// What to publish for the track mpv is on, if it is not the one announced
/// last. A stop forgets the last one, so playing that song again later is
/// announced again.
fn next_announcement(announced: &mut Option<String>, current: Option<&Track>) -> Option<Value> {
    let Some(track) = current else {
        *announced = None;
        return None;
    };
    if announced.as_deref() == Some(track.id.as_str()) {
        return None;
    }
    *announced = Some(track.id.clone());
    Some(serde_json::json!({
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "url": track.url,
        "durationSecs": track.duration_secs,
        "artworkUrl": track.artwork_url,
    }))
}

/// mpv needs to be told where yt-dlp is: its `ytdl_hook` searches `PATH`, and
/// the copy we manage is deliberately not on it.
fn build_player(data_dir: &Path, settings: &MediaSettings) -> MpvPlayer {
    MpvPlayer::configured(
        resolve_tool(data_dir, "mpv", &settings.mpv_path).unwrap_or_default(),
        resolve_tool(data_dir, "yt-dlp", &settings.yt_dlp_path),
        &settings.audio_quality,
    )
    .with_log_file(mpv_log_path(data_dir))
    .with_javascript_runtime(resolve_tool(data_dir, "deno", ""))
}

/// mpv's own log, next to the app's files. Its stdout/stderr are discarded, so
/// a player that stops on its own is only diagnosable through this file.
pub fn mpv_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("mpv.log")
}

/// Prefer a binary we downloaded ourselves over whatever is on the machine, so
/// behaviour does not change with the user's `PATH` — but an explicit override
/// always wins.
fn resolve_tool(data_dir: &Path, tool: &str, override_path: &str) -> Option<PathBuf> {
    if !override_path.trim().is_empty() {
        return binaries::locate(tool, override_path);
    }
    let managed = provision::managed_path(data_dir, tool);
    if managed.is_file() {
        return Some(managed);
    }
    binaries::locate(tool, "")
}

/// Spoken numbers, because a transcript says "volume trinta" as often as
/// "volume 30". Only the round values a person actually says out loud.
const SPOKEN_LEVELS: &[(&str, u8)] = &[
    ("zero", 0),
    ("dez", 10),
    ("ten", 10),
    ("quinze", 15),
    ("fifteen", 15),
    ("vinte", 20),
    ("twenty", 20),
    ("trinta", 30),
    ("thirty", 30),
    ("quarenta", 40),
    ("forty", 40),
    ("cinquenta", 50),
    ("fifty", 50),
    ("sessenta", 60),
    ("sixty", 60),
    ("setenta", 70),
    ("seventy", 70),
    ("oitenta", 80),
    ("eighty", 80),
    ("noventa", 90),
    ("ninety", 90),
    ("cem", 100),
    ("cento", 100),
    ("hundred", 100),
    ("maximo", 100),
    ("max", 100),
    ("metade", 50),
    ("half", 50),
];

/// Read a volume out of a slot that may be digits or words.
pub fn parse_level(raw: &str) -> Option<u8> {
    let normalized = crate::commands::matcher::normalize(raw);
    for token in normalized.split(' ') {
        if let Ok(value) = token.parse::<u32>() {
            return Some(value.min(100) as u8);
        }
    }
    SPOKEN_LEVELS
        .iter()
        .find(|(word, _)| normalized.split(' ').any(|token| token == *word))
        .map(|(_, value)| *value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaReport {
    pub resolver: String,
    pub player_found: bool,
    pub binaries: Vec<ToolStatus>,
    /// True when something is missing that this platform can fetch on its own.
    pub can_install: bool,
    pub now_playing: NowPlaying,
}

pub struct MediaService {
    settings: Mutex<MediaSettings>,
    /// Shared with the background task that queues related songs.
    player: Arc<Mutex<MpvPlayer>>,
    http: reqwest::Client,
    /// App data directory: where downloaded binaries live.
    data_dir: PathBuf,
    /// Ticket taken by each `media_play` before it searches.
    ///
    /// Resolving a track is a network round trip, so two plays overlap and the
    /// one that *finishes* last wins the player — which is not the one the user
    /// asked for last. A short query ("the", from half a sentence) searches for
    /// seconds and then takes the music away from the request that followed it.
    ///
    /// Related songs queued in the background check it too, so they are never
    /// appended to a queue the user has since replaced.
    play_generation: Arc<AtomicU64>,
    /// Where `media.playing` goes; unset until the host wires the bus.
    publisher: Mutex<Option<Publisher>>,
    /// Id of the track last announced on `media.playing`.
    announced: Mutex<Option<String>>,
}

impl MediaService {
    pub fn new(settings: MediaSettings, http: reqwest::Client, data_dir: PathBuf) -> Self {
        let player = build_player(&data_dir, &settings);
        MediaService {
            settings: Mutex::new(settings),
            player: Arc::new(Mutex::new(player)),
            http,
            data_dir,
            play_generation: Arc::new(AtomicU64::new(0)),
            publisher: Mutex::new(None),
            announced: Mutex::new(None),
        }
    }

    fn announce_track(&self) {
        let Some(publisher) = self.publisher.lock().expect("publisher poisoned").clone() else {
            return;
        };
        let current = self.player.lock().expect("player poisoned").current();
        let payload = next_announcement(
            &mut self.announced.lock().expect("announced poisoned"),
            current.as_ref(),
        );
        if let Some(payload) = payload {
            publisher.publish(TOPIC_PLAYING, payload);
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Where mpv writes its own log (fresh on every play).
    pub fn mpv_log_path(&self) -> PathBuf {
        mpv_log_path(&self.data_dir)
    }

    /// Kill players left behind by a previous run. See `player::reap_orphans`.
    pub fn reap_orphans(&self) -> usize {
        super::player::reap_orphans()
    }

    /// Download whatever is missing and can be fetched here. Safe to call on
    /// every start: installed tools short-circuit.
    pub async fn install_dependencies(&self) -> Result<Vec<ToolStatus>> {
        self.install_dependencies_with(|_| {}).await
    }

    /// `progress` is called with a human-readable step before each download, so
    /// the startup screen can show what is actually happening instead of an
    /// indeterminate spinner.
    pub async fn install_dependencies_with(
        &self,
        progress: impl Fn(&str),
    ) -> Result<Vec<ToolStatus>> {
        let settings = self.settings();
        let mut errors = Vec::new();
        for (tool, override_path) in [
            ("mpv", settings.mpv_path.as_str()),
            ("yt-dlp", settings.yt_dlp_path.as_str()),
            ("deno", ""),
        ] {
            if resolve_tool(&self.data_dir, tool, override_path).is_some() {
                continue;
            }
            if provision::spec_for(tool).is_none() {
                continue; // nothing to do here; `report` explains why
            }
            progress(&format!("Downloading {tool}"));
            if let Err(error) = provision::ensure(&self.http, &self.data_dir, tool).await {
                errors.push(error.to_string());
            }
        }
        // Pick up a freshly installed mpv without restarting.
        self.apply_settings(self.settings()).await?;
        if !errors.is_empty() {
            return Err(AppError::other(errors.join("; ")));
        }
        Ok(self.tool_statuses())
    }

    fn tool_statuses(&self) -> Vec<ToolStatus> {
        let settings = self.settings();
        let mut statuses = vec![
            provision::status(&self.data_dir, "mpv", &settings.mpv_path),
            provision::status(&self.data_dir, "yt-dlp", &settings.yt_dlp_path),
        ];
        if provision::spec_for("deno").is_some() {
            statuses.push(provision::status(&self.data_dir, "deno", ""));
        }
        statuses
    }

    /// Re-read settings after the user edits them, including re-locating mpv:
    /// installing it should not require restarting the app.
    pub async fn apply_settings(&self, settings: MediaSettings) -> Result<()> {
        let next = build_player(&self.data_dir, &settings);
        let volume = settings.volume;
        *self.settings.lock().expect("media settings poisoned") = settings;
        self.with_player(move |player| {
            if player.is_running() {
                // A running mpv holds its own volume: without pushing the new value
                // the settings slider moved while the music did not.
                player.set_base_volume(volume)?;
            } else {
                *player = next;
            }
            Ok(())
        })
        .await
    }

    fn settings(&self) -> MediaSettings {
        self.settings
            .lock()
            .expect("media settings poisoned")
            .clone()
    }

    /// Choose a resolver. `auto` prefers yt-dlp when it is installed and falls
    /// back to the HTTP one, which is also the headless Linux device default.
    fn resolver(&self, settings: &MediaSettings) -> Resolver {
        let yt_dlp = resolve_tool(&self.data_dir, "yt-dlp", &settings.yt_dlp_path);
        let runtime = resolve_tool(&self.data_dir, "deno", "");
        match settings.resolver.as_str() {
            "yt-dlp" => match yt_dlp {
                Some(bin) => Resolver::YtDlp { bin, runtime },
                None => Resolver::Http {
                    base_url: settings.http_resolver_url.clone(),
                },
            },
            "http" => Resolver::Http {
                base_url: settings.http_resolver_url.clone(),
            },
            _ => match yt_dlp {
                Some(bin) => Resolver::YtDlp { bin, runtime },
                None => Resolver::Http {
                    base_url: settings.http_resolver_url.clone(),
                },
            },
        }
    }

    fn require_player(&self, settings: &MediaSettings) -> Result<()> {
        if resolve_tool(&self.data_dir, "mpv", &settings.mpv_path).is_some() {
            return Ok(());
        }
        if provision::spec_for("mpv").is_some() {
            return Err(AppError::other(
                "mpv is still downloading — try again in a moment",
            ));
        }
        let hint = binaries::status("mpv", &settings.mpv_path).install_hint;
        Err(AppError::other(format!(
            "mpv is not available for automatic install on this platform — run `{hint}`"
        )))
    }

    /// Synchronous shutdown, for teardown paths that must not enter an async
    /// runtime (window close, `Drop`).
    pub fn stop_playback(&self) {
        let _ = self.player.lock().expect("player poisoned").stop();
    }

    /// Live loudness of the playing track. Never waits: while `media_play`
    /// holds the player (seconds, opening a stream) this simply has no reading.
    pub fn levels(&self) -> Option<super::player::AudioLevels> {
        self.player.try_lock().ok()?.levels()
    }

    pub async fn report(&self) -> Result<MediaReport> {
        let settings = self.settings();
        let resolver = self.resolver(&settings);
        let binaries = self.tool_statuses();
        Ok(MediaReport {
            resolver: resolver.id().to_string(),
            player_found: resolve_tool(&self.data_dir, "mpv", &settings.mpv_path).is_some(),
            can_install: binaries.iter().any(|t| !t.found && t.can_install),
            binaries,
            now_playing: self.with_player(|player| Ok(player.status())).await?,
        })
    }

    pub async fn run_tool(
        &self,
        tool: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let value = self.run_tool_inner(tool, args).await?;
        Ok(with_end_session(tool, value))
    }

    async fn run_tool_inner(
        &self,
        tool: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let settings = self.settings();
        let string_arg = |key: &str| {
            args.get(key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };

        match tool {
            "media_search" => {
                let query = string_arg("query").unwrap_or_default();
                if query.chars().count() > 200 {
                    return Err(AppError::other("search query is too long"));
                }
                let query = Query {
                    track: Some(query),
                    limit: args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize,
                    ..Default::default()
                };
                let tracks = self
                    .resolver(&settings)
                    .search_catalog(&self.http, &query)
                    .await?;
                Ok(serde_json::json!({
                    "tracks": tracks.into_iter().take(query.effective_limit()).map(|track| serde_json::json!({
                        "id": track.id,
                        "title": track.title,
                        "artist": track.artist,
                        "artworkUrl": track.artwork_url,
                        "durationSecs": track.duration_secs,
                    })).collect::<Vec<_>>()
                }))
            }
            "media_play" => {
                if let Some(id) = string_arg("trackId") {
                    return self
                        .play_id(&settings, &id, settings.autoplay_related)
                        .await;
                }
                let query = Query {
                    track: string_arg("track"),
                    artist: string_arg("artist"),
                    limit: args.get("limit").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                };
                // A bare "play some music" carries no track or artist: there
                // is nothing to search for, so this follows the same seed as
                // `media_radio` — keep going from what is already playing —
                // instead of silently failing to match at all.
                if query.is_empty() {
                    return self.play_related_to_current(&settings).await;
                }
                self.play(&settings, &query, settings.autoplay_related)
                    .await
            }
            "media_radio" => {
                let query = Query {
                    track: string_arg("track"),
                    artist: string_arg("artist"),
                    limit: 1,
                };
                if !query.is_empty() {
                    return self.play(&settings, &query, true).await;
                }
                self.play_related_to_current(&settings).await
            }
            "media_volume" => {
                let raw = string_arg("level").unwrap_or_default();
                let level = parse_level(&raw).ok_or_else(|| {
                    AppError::other(format!("could not read a volume from \"{raw}\""))
                })?;
                {
                    let mut current = self.settings.lock().expect("media settings poisoned");
                    current.volume = level;
                }
                let playing = self
                    .with_player(move |player| player.set_volume(level))
                    .await?;
                Ok(serde_json::to_value(playing)?)
            }
            "media_duck" => {
                let on = args.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                let percent = settings.duck_percent;
                self.with_player(move |player| player.duck(on, percent))
                    .await?;
                Ok(serde_json::json!({ "ducked": on }))
            }
            "media_status" => Ok(serde_json::to_value(self.report().await?)?),
            "media_install_deps" => Ok(serde_json::to_value(self.install_dependencies().await?)?),
            _ => {
                let tool = tool.to_string();
                let playing = self
                    .with_player(move |player| match tool.as_str() {
                        "media_pause" => player.pause(),
                        "media_resume" => player.resume(),
                        "media_next" => player.next_track(),
                        "media_previous" => player.previous(),
                        "media_stop" => {
                            player.stop()?;
                            Ok(NowPlaying::default())
                        }
                        other => Err(AppError::other(format!("unknown media tool: {other}"))),
                    })
                    .await?;
                Ok(serde_json::to_value(playing)?)
            }
        }
    }
}

/// Tools that start or resume audio.
///
/// Music in the room is not a conversation: a live call hears it and answers
/// it, turn after turn. So starting playback ends the call — the wake word
/// stays armed, and saying "lilo" brings the assistant back.
fn starts_playback(tool: &str) -> bool {
    matches!(
        tool,
        "media_play" | "media_radio" | "media_resume" | "media_next" | "media_previous"
    )
}

/// A playback-starting result carries `endSession`, which the host forwards to
/// the frontend (`lilo://end-session`); every other result is left untouched.
fn with_end_session(tool: &str, value: serde_json::Value) -> serde_json::Value {
    if !starts_playback(tool) {
        return value;
    }
    match value {
        serde_json::Value::Object(mut fields) => {
            fields.insert("endSession".to_string(), serde_json::Value::Bool(true));
            serde_json::Value::Object(fields)
        }
        other => other,
    }
}

impl MediaService {
    async fn with_player<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut MpvPlayer) -> Result<T> + Send + 'static,
    {
        let player = Arc::clone(&self.player);
        tokio::task::spawn_blocking(move || {
            let mut player = player
                .lock()
                .map_err(|_| AppError::other("Media player state is unavailable."))?;
            operation(&mut player)
        })
        .await
        .map_err(|_| AppError::other("Media player operation could not finish."))?
    }

    async fn play_id(
        &self,
        settings: &MediaSettings,
        id: &str,
        autoplay: bool,
    ) -> Result<serde_json::Value> {
        self.require_player(settings)?;
        let ticket = self.play_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let resolver = self.resolver(settings);
        let track = resolver.resolve_id(&self.http, id).await?;
        self.start_tracks(settings, resolver, vec![track], ticket, autoplay)
            .await
    }

    /// Search, play, and with `autoplay` keep going with related songs.
    async fn play(
        &self,
        settings: &MediaSettings,
        query: &Query,
        autoplay: bool,
    ) -> Result<serde_json::Value> {
        self.require_player(settings)?;
        let ticket = self.play_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Resolve before touching the player: the lock must never be held
        // across an await.
        let resolver = self.resolver(settings);
        let tracks = resolver.search(&self.http, query).await?;
        self.start_tracks(settings, resolver, tracks, ticket, autoplay)
            .await
    }

    /// Start a resolved queue after the network lookup. Both voice search and
    /// picker selection share the same stale-request and autoplay behavior.
    async fn start_tracks(
        &self,
        settings: &MediaSettings,
        resolver: Resolver,
        tracks: Vec<Track>,
        ticket: u64,
        autoplay: bool,
    ) -> Result<serde_json::Value> {
        // Someone asked for something else while we were searching, so this
        // answer is stale. Report what is actually playing instead of seizing
        // the player and contradicting the newer request.
        let seed = tracks
            .first()
            .cloned()
            .ok_or_else(|| AppError::other("No tracks were found."))?;
        let generation = Arc::clone(&self.play_generation);
        let volume = settings.volume;
        let (playing, known) = self
            .with_player(move |player| {
                if generation.load(Ordering::SeqCst) != ticket {
                    return Ok((player.status(), None));
                }
                let playing = player.play(tracks, volume)?;
                Ok((playing, Some(player.queued_ids())))
            })
            .await?;
        if autoplay {
            if let Some(known) = known {
                self.queue_related(resolver, seed, known, ticket);
            }
        }
        Ok(serde_json::to_value(playing)?)
    }

    /// No track or artist named: queue more songs like whatever is already
    /// playing. Shared by `media_play` and `media_radio`, which both fall
    /// back to this once their query turns out empty.
    async fn play_related_to_current(&self, settings: &MediaSettings) -> Result<serde_json::Value> {
        let (seed, known) = self
            .with_player(|player| {
                let seed = player.current().ok_or_else(|| {
                    AppError::other("nothing is playing — name a song to start from")
                })?;
                Ok((seed, player.queued_ids()))
            })
            .await?;
        // A new ticket: this replaces what was coming next, including
        // related songs an earlier play is still fetching.
        let ticket = self.play_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let related = self
            .resolver(settings)
            .related(&self.http, &seed, &known, RELATED_LIMIT)
            .await?;
        let generation = Arc::clone(&self.play_generation);
        let playing = self
            .with_player(move |player| {
                if generation.load(Ordering::SeqCst) != ticket {
                    return Ok(player.status());
                }
                player.append(related, true)
            })
            .await?;
        Ok(serde_json::to_value(playing)?)
    }

    /// Fetch songs related to `seed` and queue them behind what is playing.
    ///
    /// In the background: the music has already started, and the answer to
    /// "play X" should not wait on a second search. Dropped silently when it
    /// fails or when a newer request has replaced the queue meanwhile — the
    /// requested song still plays, it just ends where it used to.
    fn queue_related(&self, resolver: Resolver, seed: Track, known: Vec<String>, ticket: u64) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let player = Arc::clone(&self.player);
        let generation = Arc::clone(&self.play_generation);
        let http = self.http.clone();
        runtime.spawn(async move {
            let Ok(related) = resolver.related(&http, &seed, &known, RELATED_LIMIT).await else {
                return;
            };
            let _ = tokio::task::spawn_blocking(move || {
                let Ok(mut player) = player.lock() else {
                    return;
                };
                if generation.load(Ordering::SeqCst) == ticket {
                    let _ = player.append(related, false);
                }
            })
            .await;
        });
    }
}

impl std::fmt::Debug for MediaService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaService").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test(flavor = "current_thread")]
    async fn player_operations_do_not_block_async_progress() {
        let service = service();
        let (send, receive) = std::sync::mpsc::channel();
        let (result, ()) = tokio::join!(
            service.with_player(move |_| {
                receive
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .map_err(|_| AppError::other("Async progress was blocked."))?;
                Ok(())
            }),
            async {
                tokio::task::yield_now().await;
                send.send(()).unwrap();
            }
        );
        result.unwrap();
    }

    fn service() -> MediaService {
        MediaService::new(
            MediaSettings::default(),
            reqwest::Client::new(),
            std::env::temp_dir().join(format!("lilo-media-{}", uuid::Uuid::new_v4())),
        )
    }

    #[test]
    fn levels_read_digits_and_spoken_numbers() {
        assert_eq!(parse_level("30"), Some(30));
        assert_eq!(parse_level("em 45"), Some(45));
        assert_eq!(parse_level("trinta"), Some(30));
        assert_eq!(parse_level("TRINTA"), Some(30));
        assert_eq!(parse_level("seventy"), Some(70));
        assert_eq!(parse_level("no máximo"), Some(100));
        assert_eq!(parse_level("metade"), Some(50));
    }

    #[test]
    fn levels_are_clamped_and_rejected_when_absent() {
        assert_eq!(parse_level("500"), Some(100));
        assert_eq!(parse_level("alguma coisa"), None);
        assert_eq!(parse_level(""), None);
    }

    #[test]
    fn every_registry_media_tool_is_handled() {
        // The registry and this service must not drift apart.
        for tool in TOOL_NAMES {
            assert!(handles(tool), "{tool}");
        }
        assert!(handles("media_play"));
        assert!(!handles("web_search"));
    }

    /// Starting music must hang up, or the call hears the song and keeps
    /// answering it. Pausing, stopping and changing the volume must not: the
    /// user is still talking.
    #[test]
    fn starting_playback_ends_the_live_call() {
        for tool in [
            "media_play",
            "media_radio",
            "media_resume",
            "media_next",
            "media_previous",
        ] {
            let value = with_end_session(tool, json!({ "title": "x" }));
            assert_eq!(value["endSession"], true, "{tool} starts audio");
        }
        for tool in [
            "media_search",
            "media_pause",
            "media_stop",
            "media_volume",
            "media_status",
            "media_duck",
        ] {
            let value = with_end_session(tool, json!({ "title": "x" }));
            assert!(value.get("endSession").is_none(), "{tool} must not hang up");
        }
    }

    #[test]
    fn every_media_tool_is_described() {
        // The descriptors drive the settings UI and the model prompt, so a tool
        // the service handles but never describes is invisible to both.
        let names: Vec<_> = descriptors().into_iter().map(|tool| tool.name).collect();
        for tool in TOOL_NAMES {
            assert!(
                names.iter().any(|name| name == tool),
                "{tool} has no descriptor"
            );
        }
    }

    #[test]
    fn media_descriptors_are_well_formed() {
        for tool in descriptors() {
            assert!(tool.name.starts_with("media_"), "{}", tool.name);
            assert!(!tool.description.is_empty(), "{}", tool.name);
            assert!(tool.parameters["type"] == "object");
        }
    }

    #[test]
    fn the_service_is_a_tool_provider_for_its_own_tools() {
        use crate::plugins::ToolProvider;
        let service = service();
        assert!(service.manifest().is_compatible());
        assert_eq!(service.manifest().id, "core.media");
        assert!(service.handles("media_search"));
        assert!(service.handles("media_play"));
        assert!(!service.handles("get_current_time"));
    }

    #[tokio::test]
    async fn an_unknown_media_tool_is_an_error() {
        let err = service()
            .run_tool("media_teleport", &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown media tool"));
    }

    #[test]
    fn a_downloaded_binary_wins_over_the_system_one() {
        let data = std::env::temp_dir().join(format!("lilo-resolve-{}", uuid::Uuid::new_v4()));
        let managed = super::super::provision::managed_path(&data, "yt-dlp");
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::fs::write(&managed, b"x").unwrap();
        assert_eq!(resolve_tool(&data, "yt-dlp", ""), Some(managed));
        // An explicit path still overrides everything.
        assert_eq!(
            resolve_tool(&data, "yt-dlp", "/definitely/not/yt-dlp"),
            None
        );
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn installing_is_a_no_op_when_nothing_can_be_fetched_here() {
        // Platforms without a spec must not turn into an error: the report is
        // what tells the user to install by hand.
        let service = MediaService::new(
            MediaSettings {
                mpv_path: "/definitely/not/mpv".into(),
                yt_dlp_path: "/definitely/not/yt-dlp".into(),
                ..MediaSettings::default()
            },
            reqwest::Client::new(),
            std::env::temp_dir().join(format!("lilo-noinstall-{}", uuid::Uuid::new_v4())),
        );
        let report = service.report().await.unwrap();
        assert!(!report.player_found);
        assert_eq!(
            report.binaries.len(),
            if provision::spec_for("deno").is_some() {
                3
            } else {
                2
            }
        );
    }

    #[tokio::test]
    async fn playing_without_mpv_installed_names_the_install_command() {
        let service = MediaService::new(
            MediaSettings {
                mpv_path: "/definitely/not/mpv".into(),
                ..MediaSettings::default()
            },
            reqwest::Client::new(),
            std::env::temp_dir().join(format!("lilo-media-{}", uuid::Uuid::new_v4())),
        );
        let err = service
            .run_tool("media_play", &json!({ "track": "creep" }))
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("mpv is still downloading")
                || message.contains("mpv is not available"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn similar_songs_need_something_to_start_from() {
        let err = service()
            .run_tool("media_radio", &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("name a song"), "{err}");
    }

    #[test]
    fn each_new_track_is_announced_once() {
        let track = |id: &str| Track {
            id: id.to_string(),
            title: format!("song {id}"),
            artist: "someone".to_string(),
            url: format!("https://example.test/{id}"),
            duration_secs: Some(200),
            artwork_url: Some("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg".into()),
        };
        let mut announced = None;
        let first = super::next_announcement(&mut announced, Some(&track("a"))).unwrap();
        assert_eq!(first["title"], "song a");
        assert_eq!(first["durationSecs"], 200);
        assert_eq!(
            first["artworkUrl"],
            "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
        );
        // Still on it: the watcher polls, but nothing new is published.
        assert!(super::next_announcement(&mut announced, Some(&track("a"))).is_none());
        // mpv moved down the queue on its own.
        assert!(super::next_announcement(&mut announced, Some(&track("b"))).is_some());
        // Stopped, then the same song again: it counts as a new play.
        assert!(super::next_announcement(&mut announced, None).is_none());
        assert!(super::next_announcement(&mut announced, Some(&track("b"))).is_some());
    }

    #[tokio::test]
    async fn playing_with_no_track_or_artist_also_needs_something_to_start_from() {
        // A bare "play some music" with nothing playing yet has no seed to
        // search related songs from, same as `media_radio`.
        let err = service()
            .run_tool("media_play", &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("name a song"), "{err}");
    }

    #[test]
    fn autoplay_is_on_unless_turned_off() {
        assert!(MediaSettings::default().autoplay_related);
        let old: MediaSettings = serde_json::from_value(json!({
            "backend": "mpv", "resolver": "auto", "mpvPath": "", "ytDlpPath": "",
            "httpResolverUrl": "", "volume": 70, "duckPercent": 45
        }))
        .unwrap();
        assert!(
            old.autoplay_related,
            "settings saved before the option keep autoplay on"
        );
    }

    #[tokio::test]
    async fn volume_without_a_readable_level_is_rejected() {
        let err = service()
            .run_tool("media_volume", &json!({ "level": "banana" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("could not read a volume"));
    }

    #[test]
    fn stopping_playback_is_safe_when_nothing_plays() {
        service().stop_playback();
    }

    #[tokio::test]
    async fn ducking_is_safe_when_nothing_plays() {
        let result = service()
            .run_tool("media_duck", &json!({ "on": true }))
            .await;
        assert_eq!(result.unwrap()["ducked"], json!(true));
    }

    #[tokio::test]
    async fn status_reports_the_binaries_and_resolver() {
        let report = service()
            .run_tool("media_status", &json!({}))
            .await
            .unwrap();
        assert!(report["binaries"].as_array().unwrap().len() >= 2);
        assert!(!report["resolver"].as_str().unwrap().is_empty());
    }

    /// The whole path, for real: provision, resolve, play, report, stop.
    /// Volume 0 so running it does not blast audio at whoever runs it.
    ///
    ///   cargo test -p lilo-core -- --ignored --nocapture plays_for_real
    #[tokio::test]
    #[ignore = "network + spawns mpv"]
    async fn plays_for_real() {
        // Point at the real app data directory to reproduce exactly what the
        // installed app sees:  LILO_E2E_DATA_DIR=~/Library/... cargo test ...
        let data = std::env::var_os("LILO_E2E_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("lilo-e2e-{}", uuid::Uuid::new_v4()))
            });
        let service = MediaService::new(
            MediaSettings {
                volume: 0,
                ..MediaSettings::default()
            },
            reqwest::Client::new(),
            data.clone(),
        );

        service
            .install_dependencies()
            .await
            .expect("dependencies must install");
        let report = service.report().await.unwrap();
        eprintln!(
            "resolver={} player_found={}",
            report.resolver, report.player_found
        );
        assert!(report.player_found, "mpv must be available after install");

        let played = service
            .run_tool("media_play", &json!({ "track": "bohemian rhapsody queen" }))
            .await
            .expect("play must succeed");
        eprintln!("now playing: {played}");
        assert!(
            played["queueLength"].as_u64().unwrap_or(0) > 0,
            "something must be queued"
        );

        let status = service.run_tool("media_status", &json!({})).await.unwrap();
        eprintln!("status: {}", status["nowPlaying"]);
        assert!(status["nowPlaying"]["queueLength"].as_u64().unwrap_or(0) > 0);

        // mpv quits by itself when the heartbeat file stops being refreshed
        // (watchdog timeout is 5 s). Stay well past that: a stale heartbeat
        // used to kill every track a few seconds in.
        tokio::time::sleep(std::time::Duration::from_secs(9)).await;
        let still = service.run_tool("media_status", &json!({})).await.unwrap();
        assert!(
            still["nowPlaying"]["queueLength"].as_u64().unwrap_or(0) > 0,
            "mpv must still be playing past the watchdog timeout"
        );

        // The previous version of this test asserted only on our own queue
        // vector, so it passed while mpv was exiting with "Failed to recognize
        // file format". `media_play` now waits for mpv to report a real
        // duration, so reaching this line means audio genuinely opened.

        // Autoplay queues related songs in the background, behind the one asked for.
        let mut queued = 0;
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let status = service.run_tool("media_status", &json!({})).await.unwrap();
            queued = status["nowPlaying"]["queueLength"].as_u64().unwrap_or(0);
            if queued > 1 {
                break;
            }
        }
        eprintln!("queued with related songs: {queued}");
        assert!(queued > 1, "related songs must follow the requested one");

        let next = service
            .run_tool("media_next", &json!({}))
            .await
            .expect("next");
        eprintln!("next: {next}");
        assert_eq!(next["queueLength"].as_u64(), Some(queued - 1));

        service
            .run_tool("media_pause", &json!({}))
            .await
            .expect("pause");
        service
            .run_tool("media_resume", &json!({}))
            .await
            .expect("resume");
        service
            .run_tool("media_stop", &json!({}))
            .await
            .expect("stop");

        let after = service.report().await.unwrap();
        assert_eq!(
            after.now_playing.queue_length, 0,
            "stop must clear the queue"
        );
        if std::env::var_os("LILO_E2E_DATA_DIR").is_none() {
            let _ = std::fs::remove_dir_all(data);
        }
    }

    #[test]
    fn resolver_choice_falls_back_when_yt_dlp_is_absent() {
        let service = service();
        let settings = MediaSettings {
            resolver: "yt-dlp".into(),
            yt_dlp_path: "/definitely/not/yt-dlp".into(),
            ..MediaSettings::default()
        };
        assert_eq!(
            service.resolver(&settings).id(),
            "http",
            "an explicit yt-dlp choice must still degrade rather than fail"
        );

        let forced = MediaSettings {
            resolver: "http".into(),
            ..MediaSettings::default()
        };
        assert_eq!(service.resolver(&forced).id(), "http");
    }
}
