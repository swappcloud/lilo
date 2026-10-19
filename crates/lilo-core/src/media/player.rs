//! mpv as the playback engine, driven over its JSON IPC socket.
//!
//! mpv is the one piece that behaves the same on macOS, Windows and a
//! headless Linux device, and `--no-video` with a bounded cache keeps it inside a
//! 512 MB board's budget.
//!
//! Transport is a unix socket everywhere except Windows, which uses a named
//! pipe. Both are just line-delimited JSON, so only the connect step differs.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{AppError, Result};

/// Bounded so a 512 MB board never buffers a whole track into RAM.
const MPV_ARGS: &[&str] = &[
    "--no-video",
    "--no-terminal",
    "--idle=once",
    "--really-quiet",
    "--cache=yes",
    "--demuxer-max-bytes=8MiB",
    "--demuxer-readahead-secs=20",
    // Pass-through loudness stats, read back as `af-metadata/lilolevel`: mpv
    // plays outside the WebView's audio graph, so this is the only way the
    // visualizer can follow the actual music.
    "--af=@lilolevel:lavfi=[astats=metadata=1:reset=1]",
];

/// Loudness of what mpv is playing right now, 0..1 each.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct AudioLevels {
    pub level: f32,
    /// Weight of low frequencies (beat, bass).
    pub low: f32,
    /// Weight of high frequencies (voice, cymbals).
    pub high: f32,
}

fn stat(metadata: &serde_json::Value, key: &str) -> Option<f64> {
    let value = metadata.get(format!("lavfi.astats.Overall.{key}"))?;
    let text = value.as_str()?;
    let number: f64 = text.trim().parse().ok()?;
    number.is_finite().then_some(number)
}

/// Turn `astats` frame metadata into levels.
///
/// RMS in dBFS maps -45..-10 dB onto 0..1. Brightness comes from the RMS of the
/// sample-to-sample difference relative to the RMS amplitude: a pure low tone
/// barely changes between samples, bright content changes a lot. Full scale is
/// recovered from the peak (`max |sample|` against its dB), so integer and
/// float sample formats read the same.
pub fn parse_levels(metadata: &serde_json::Value) -> Option<AudioLevels> {
    let rms_db = match metadata.get("lavfi.astats.Overall.RMS_level")?.as_str()? {
        text if text.contains("inf") => {
            return Some(AudioLevels {
                level: 0.0,
                low: 0.0,
                high: 0.0,
            });
        }
        text => text.trim().parse::<f64>().ok()?,
    };
    let level = ((rms_db + 45.0) / 35.0).clamp(0.0, 1.0);
    let peak_db = stat(metadata, "Peak_level")?;
    let max_abs = stat(metadata, "Max_level")?
        .abs()
        .max(stat(metadata, "Min_level").unwrap_or(0.0).abs());
    let full_scale = max_abs / 10f64.powf(peak_db / 20.0);
    let rms_amplitude = full_scale * 10f64.powf(rms_db / 20.0);
    let brightness = match stat(metadata, "RMS_difference") {
        Some(diff) if rms_amplitude > 0.0 => (diff / rms_amplitude * 2.5).clamp(0.0, 1.0),
        _ => 0.3,
    };
    Some(AudioLevels {
        level: level as f32,
        low: (level * (1.0 - brightness * 0.6)) as f32,
        high: (level * brightness).min(1.0) as f32,
    })
}

/// Stream selection per quality setting.
///
/// Capping at 128 kbps everywhere was a headless Linux device constraint applied to
/// desktops that have no such problem — it just made music sound worse.
pub fn ytdl_format(quality: &str) -> &'static str {
    match quality.trim() {
        // Explicitly frugal: small boards, metered connections.
        "low" => "bestaudio[abr<=?128]/bestaudio/best",
        // Prefer a real audio-only stream, best bitrate available.
        _ => "bestaudio[acodec!=none][vcodec=none]/bestaudio/best",
    }
}

/// How long to wait for mpv to create its IPC endpoint before giving up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long to wait for a stream to actually open. Resolving a YouTube URL
/// through yt-dlp regularly takes several seconds on a slow link.
const PLAYBACK_TIMEOUT: Duration = Duration::from_secs(25);

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Encode one mpv IPC command. Public for testing: the wire format is the part
/// worth pinning down, and it needs no process to verify.
pub fn encode_command(args: &[serde_json::Value], request_id: u64) -> String {
    let payload = serde_json::json!({ "command": args, "request_id": request_id });
    format!("{payload}\n")
}

/// Read one IPC reply. mpv interleaves unsolicited events with replies, so the
/// caller must skip anything without a matching `request_id`.
pub fn parse_response(line: &str, request_id: u64) -> Option<Result<serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("request_id").and_then(|v| v.as_u64()) != Some(request_id) {
        return None;
    }
    match value.get("error").and_then(|v| v.as_str()) {
        Some("success") | None => Some(Ok(value
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null))),
        Some(other) => Some(Err(AppError::other(format!("mpv: {other}")))),
    }
}

/// The volume mpv is set to while the assistant is speaking. Without ducking
/// the music and the assistant talk over each other.
pub fn ducked_volume(volume: u8, duck_percent: u8) -> u8 {
    let factor = u32::from(duck_percent.min(100));
    ((u32::from(volume) * factor) / 100) as u8
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    pub queue_length: usize,
    pub paused: bool,
    pub volume: u8,
}

/// Marker present in every file we create for a player, so strays can be
/// recognised and cleaned up later.
const IPC_MARKER: &str = "lilo-mpv-";

/// How often the parent refreshes the liveness file.
const HEARTBEAT_EVERY: Duration = Duration::from_secs(1);

/// mpv quits if the heartbeat file goes this stale. Long enough to survive a
/// busy machine, short enough that nobody sits through orphaned audio.
const HEARTBEAT_TIMEOUT_SECS: u64 = 5;

/// Lua watchdog, embedded into mpv itself.
///
/// This is what makes cleanup unconditional. Stopping the player, the exit
/// handler and the startup reaper all cover an app that gets the chance to act;
/// none of them run when the process is SIGKILLed and never started again. mpv
/// watching its own parent needs nobody to come back.
///
/// A file's mtime is the portable signal: no /proc, no shell, no signals.
const WATCHDOG_LUA: &str = r#"
local utils = require 'mp.utils'
local heartbeat = mp.get_opt("lilo-heartbeat")
local timeout = tonumber(mp.get_opt("lilo-heartbeat-timeout") or "5")

if heartbeat then
    mp.add_periodic_timer(1, function()
        local info = utils.file_info(heartbeat)
        -- Gone, or no longer being refreshed: the app that owns us is dead.
        if not info or (os.time() - info.mtime) > timeout then
            mp.commandv("quit")
        end
    end)
end
"#;

#[cfg(windows)]
fn ipc_path(token: &str) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\{IPC_MARKER}{token}"))
}

#[cfg(not(windows))]
fn ipc_path(token: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{IPC_MARKER}{token}.sock"))
}

/// Kill mpv processes left behind by a previous run, and clean their sockets.
///
/// `Drop` and the exit handler cover an orderly shutdown, but neither runs when
/// the app is SIGKILLed — which is exactly what a dev restart does. Without
/// this, music from the previous run keeps playing with nothing left to stop it.
///
/// Identified by our IPC marker, so only players *we* started are touched.
pub fn reap_orphans() -> usize {
    #[cfg(unix)]
    let killed = {
        let mut killed = 0;
        let me = std::process::id();
        if let Ok(output) = std::process::Command::new("/usr/bin/pgrep")
            .arg("-f")
            .arg(IPC_MARKER)
            .output()
        {
            for pid in String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .filter(|pid| *pid != me)
            {
                // SIGTERM first: mpv closes its audio device cleanly.
                let _ = std::process::Command::new("/bin/kill")
                    .arg(pid.to_string())
                    .status();
                killed += 1;
            }
        }
        killed
    };
    // Windows has no pgrep; orphans there are reaped by the mpv watchdog
    // (stale heartbeat) instead, so only the temp files are cleaned below.
    #[cfg(not(unix))]
    let killed = 0usize;

    // Stale sockets would otherwise accumulate in the temp directory forever.
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(IPC_MARKER)
                && (name.ends_with(".sock") || name.ends_with(".alive") || name.ends_with(".lua"))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    killed
}

/// A connected IPC endpoint. Abstracted so the unix/windows split stays in one
/// place instead of leaking into every command.
struct Ipc {
    #[cfg(not(windows))]
    stream: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    stream: std::fs::File,
}

impl Ipc {
    fn connect(path: &Path) -> Result<Self> {
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        loop {
            match Self::try_connect(path) {
                Ok(ipc) => return Ok(ipc),
                Err(err) if Instant::now() >= deadline => return Err(err),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    #[cfg(not(windows))]
    fn try_connect(path: &Path) -> Result<Self> {
        let stream = std::os::unix::net::UnixStream::connect(path)?;
        // A socket accepted from a non-blocking listener inherits O_NONBLOCK on
        // BSD, and then every read fails with EWOULDBLOCK. The wake helper hit
        // exactly this; be explicit here too.
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        Ok(Ipc { stream })
    }

    #[cfg(windows)]
    fn try_connect(path: &Path) -> Result<Self> {
        let stream = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)?;
        Ok(Ipc { stream })
    }

    fn request(&mut self, args: &[serde_json::Value]) -> Result<serde_json::Value> {
        let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        self.stream.write_all(encode_command(args, id).as_bytes())?;
        self.stream.flush()?;

        let reader = BufReader::new(self.reader_handle()?);
        for line in reader.lines() {
            let line = line?;
            if let Some(result) = parse_response(&line, id) {
                return result;
            }
        }
        Err(AppError::other("mpv closed the IPC connection"))
    }

    #[cfg(not(windows))]
    fn reader_handle(&self) -> Result<std::os::unix::net::UnixStream> {
        Ok(self.stream.try_clone()?)
    }

    #[cfg(windows)]
    fn reader_handle(&self) -> Result<std::fs::File> {
        Ok(self.stream.try_clone()?)
    }
}

/// Keeps a file's mtime fresh while the owning player lives. Dropping it stops
/// the thread and removes the file, which makes mpv quit on its next check.
struct Heartbeat {
    path: PathBuf,
    stop: AtomicBool,
}

impl Heartbeat {
    fn start(path: PathBuf) -> Arc<Self> {
        let beat = Arc::new(Heartbeat {
            path,
            stop: AtomicBool::new(false),
        });
        let _ = std::fs::write(&beat.path, beat_value());
        let worker = Arc::clone(&beat);
        std::thread::spawn(move || {
            while !worker.stop.load(Ordering::Relaxed) {
                // Must be a real, non-empty write: `write_all(b"")` issues no
                // write at all, and on Windows truncating an already-empty
                // file leaves the mtime untouched — the watchdog then kills a
                // healthy player a few seconds in.
                if std::fs::write(&worker.path, beat_value()).is_err() {
                    break;
                }
                std::thread::sleep(HEARTBEAT_EVERY);
            }
        });
        beat
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Non-empty payload for the heartbeat file: its own write is what refreshes
/// the mtime the watchdog reads (and its value tells when the last beat was).
fn beat_value() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "tick".to_string())
}

pub struct MpvPlayer {
    bin: PathBuf,
    /// "high" (default) or "low".
    quality: String,
    /// Refreshed while this player is alive; mpv quits when it goes stale.
    heartbeat: Option<Arc<Heartbeat>>,
    /// Absolute path to yt-dlp, handed to mpv explicitly.
    ///
    /// mpv's `ytdl_hook` looks for yt-dlp on `PATH`, and we deliberately keep
    /// our downloaded copy *off* `PATH` so it cannot shadow a system tool. So
    /// mpv could not resolve a YouTube URL and exited with "Failed to recognize
    /// file format" — while we had already reported success.
    ytdl: Option<PathBuf>,
    runtime: Option<PathBuf>,
    child: Option<super::process::ManagedChild>,
    socket: PathBuf,
    /// mpv's own log, written fresh on every play. Its stdout/stderr are
    /// discarded, so without this a silent exit leaves no trace anywhere.
    log_file: Option<PathBuf>,
    queue: Vec<super::resolver::Track>,
    /// Index into `queue` of the track mpv is on. mpv advances by itself when a
    /// track ends, so this is read back from it rather than counted here.
    position: usize,
    volume: u8,
    paused: bool,
    ducked: bool,
}

impl std::fmt::Debug for MpvPlayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MpvPlayer")
            .field("bin", &self.bin)
            .field("running", &self.child.is_some())
            .field("queue", &self.queue.len())
            .finish()
    }
}

impl MpvPlayer {
    pub fn new(bin: PathBuf) -> Self {
        Self::with_ytdl(bin, None)
    }

    pub fn with_ytdl(bin: PathBuf, ytdl: Option<PathBuf>) -> Self {
        Self::configured(bin, ytdl, "high")
    }

    pub fn with_log_file(mut self, path: PathBuf) -> Self {
        self.log_file = Some(path);
        self
    }

    pub fn with_javascript_runtime(mut self, runtime: Option<PathBuf>) -> Self {
        self.runtime = runtime;
        self
    }

    pub fn configured(bin: PathBuf, ytdl: Option<PathBuf>, quality: &str) -> Self {
        MpvPlayer {
            bin,
            quality: quality.to_string(),
            ytdl,
            runtime: None,
            heartbeat: None,
            child: None,
            socket: ipc_path(&format!("{}", std::process::id())),
            log_file: None,
            queue: Vec::new(),
            position: 0,
            volume: 70,
            paused: false,
            ducked: false,
        }
    }

    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn play(&mut self, tracks: Vec<super::resolver::Track>, volume: u8) -> Result<NowPlaying> {
        if tracks.is_empty() {
            return Err(AppError::other("nothing to play"));
        }
        self.stop().ok();

        self.volume = volume.min(100);
        self.paused = false;
        self.ducked = false;
        self.socket = ipc_path(&format!(
            "{}-{}",
            std::process::id(),
            REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&self.socket);

        let mut command = super::process::quiet_command(&self.bin);
        super::process::javascript_runtime(&mut command, self.runtime.as_deref())?;
        command
            .args(MPV_ARGS)
            .arg(format!("--ytdl-format={}", ytdl_format(&self.quality)))
            .arg(format!("--volume={}", self.volume))
            .arg(format!("--input-ipc-server={}", self.socket.display()));
        if let Some(path) = &self.log_file {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::remove_file(path);
            command.arg(format!("--log-file={}", path.display()));
        }
        // Teach mpv to outlive us for no longer than a few seconds.
        let token = self
            .socket
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}", std::process::id()));
        let heartbeat_path = std::env::temp_dir().join(format!("{token}.alive"));
        let script_path = std::env::temp_dir().join(format!("{token}.lua"));
        let watchdog = std::fs::write(&script_path, WATCHDOG_LUA).is_ok();

        let mut script_opts = vec![format!("lilo-heartbeat={}", heartbeat_path.display())];
        script_opts.push(format!("lilo-heartbeat-timeout={HEARTBEAT_TIMEOUT_SECS}"));
        if let Some(ytdl) = &self.ytdl {
            script_opts.push(format!("ytdl_hook-ytdl_path={}", ytdl.display()));
        }
        command.arg(format!("--script-opts={}", script_opts.join(",")));
        if watchdog {
            command.arg(format!("--script={}", script_path.display()));
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        for track in &tracks {
            command.arg(&track.url);
        }

        self.heartbeat = Some(Heartbeat::start(heartbeat_path));
        self.child = Some(
            super::process::spawn(command)
                .map_err(|e| AppError::other(format!("could not start mpv: {e}")))?,
        );
        self.queue = tracks;
        self.position = 0;

        // Connecting proves mpv came up — but not that it can play anything.
        // Resolving a stream can fail long after launch, so wait for mpv to
        // report a real file before calling this a success.
        Ipc::connect(&self.socket)?;
        self.await_playback()?;
        Ok(self.snapshot())
    }

    /// Block until mpv actually opens the stream, or report why it could not.
    ///
    /// Resolving a YouTube URL takes a few seconds and can fail (no yt-dlp,
    /// geo-blocked, removed video). Reporting success on spawn turned every one
    /// of those into silence with a cheerful "now playing".
    fn await_playback(&mut self) -> Result<()> {
        let deadline = Instant::now() + PLAYBACK_TIMEOUT;
        loop {
            if !self.is_running() {
                return Err(AppError::other(
                    "mpv could not open the stream — it exited before playing",
                ));
            }
            // `duration` is only set once a real file is loaded.
            if let Ok(value) = self.command(&[
                serde_json::json!("get_property"),
                serde_json::json!("duration"),
            ]) {
                if value.as_f64().is_some_and(|d| d > 0.0) {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err(AppError::other(
                    "timed out waiting for playback to start — the track could not be opened",
                ));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn command(&mut self, args: &[serde_json::Value]) -> Result<serde_json::Value> {
        if !self.is_running() {
            return Err(AppError::other("nothing is playing"));
        }
        let mut ipc = Ipc::connect(&self.socket)?;
        ipc.request(args)
    }

    fn set_property(&mut self, name: &str, value: serde_json::Value) -> Result<()> {
        self.command(&[
            serde_json::json!("set_property"),
            serde_json::json!(name),
            value,
        ])?;
        Ok(())
    }

    pub fn pause(&mut self) -> Result<NowPlaying> {
        self.set_property("pause", serde_json::json!(true))?;
        self.paused = true;
        Ok(self.snapshot())
    }

    pub fn resume(&mut self) -> Result<NowPlaying> {
        self.set_property("pause", serde_json::json!(false))?;
        self.paused = false;
        Ok(self.snapshot())
    }

    pub fn set_volume(&mut self, volume: u8) -> Result<NowPlaying> {
        self.volume = volume.min(100);
        self.ducked = false;
        self.set_property("volume", serde_json::json!(self.volume))?;
        Ok(self.snapshot())
    }

    /// Update the volume the next track will use, *without* fighting ducking.
    ///
    /// The settings slider must move the music even while the assistant is
    /// speaking; blindly un-ducking here would blast the track the instant a
    /// slider moved mid-sentence.
    pub fn set_base_volume(&mut self, volume: u8) -> Result<NowPlaying> {
        self.volume = volume.min(100);
        if !self.ducked {
            self.set_property("volume", serde_json::json!(self.volume))?;
        }
        Ok(self.snapshot())
    }

    /// Lower the music while the assistant speaks, then restore it. A no-op
    /// when nothing is playing, so the caller can fire it on every state change.
    pub fn duck(&mut self, on: bool, duck_percent: u8) -> Result<()> {
        if !self.is_running() || self.ducked == on {
            return Ok(());
        }
        let target = if on {
            ducked_volume(self.volume, duck_percent)
        } else {
            self.volume
        };
        self.set_property("volume", serde_json::json!(target))?;
        self.ducked = on;
        Ok(())
    }

    pub fn next_track(&mut self) -> Result<NowPlaying> {
        self.command(&[
            serde_json::json!("playlist-next"),
            serde_json::json!("force"),
        ])?;
        self.sync_position();
        Ok(self.snapshot())
    }

    pub fn previous(&mut self) -> Result<NowPlaying> {
        self.command(&[
            serde_json::json!("playlist-prev"),
            serde_json::json!("force"),
        ])?;
        self.sync_position();
        Ok(self.snapshot())
    }

    /// The track mpv is on, or `None` when nothing is playing.
    pub fn current(&mut self) -> Option<super::resolver::Track> {
        if !self.is_running() {
            return None;
        }
        self.sync_position();
        self.queue.get(self.position).cloned()
    }

    /// Ids of everything queued, played or not, so related songs never repeat.
    pub fn queued_ids(&self) -> Vec<String> {
        self.queue.iter().map(|track| track.id.clone()).collect()
    }

    /// Queue `tracks` after the current one.
    ///
    /// With `replace_upcoming`, whatever was going to play next is dropped
    /// first, so "play similar songs" takes effect right after this track
    /// instead of after the rest of an old queue.
    pub fn append(
        &mut self,
        tracks: Vec<super::resolver::Track>,
        replace_upcoming: bool,
    ) -> Result<NowPlaying> {
        if !self.is_running() {
            return Err(AppError::other("nothing is playing"));
        }
        self.sync_position();
        if replace_upcoming {
            // Keeps only the current entry in mpv's playlist.
            self.command(&[serde_json::json!("playlist-clear")])?;
            if let Some(current) = self.queue.get(self.position).cloned() {
                self.queue = vec![current];
            }
            self.position = 0;
        }
        for track in tracks {
            self.command(&[
                serde_json::json!("loadfile"),
                serde_json::json!(track.url),
                serde_json::json!("append"),
            ])?;
            self.queue.push(track);
        }
        Ok(self.snapshot())
    }

    /// Follow mpv to the track it is actually on. A failed read keeps the last
    /// known position rather than jumping the display back to the first track.
    fn sync_position(&mut self) {
        let Ok(value) = self.command(&[
            serde_json::json!("get_property"),
            serde_json::json!("playlist-pos"),
        ]) else {
            return;
        };
        if let Some(pos) = value.as_i64().filter(|pos| *pos >= 0) {
            self.position = (pos as usize).min(self.queue.len().saturating_sub(1));
        }
    }

    pub fn stop(&mut self) -> Result<()> {
        if self.is_running() {
            let _ = self.command(&[serde_json::json!("quit")]);
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(beat) = self.heartbeat.take() {
            beat.stop();
        }
        let _ = std::fs::remove_file(&self.socket);
        self.queue.clear();
        self.position = 0;
        self.paused = false;
        self.ducked = false;
        Ok(())
    }

    /// Live loudness of the playing track; `None` while stopped or paused.
    pub fn levels(&mut self) -> Option<AudioLevels> {
        if self.paused || !self.is_running() {
            return None;
        }
        // One attempt, no retry: this runs 20 times a second while holding the
        // player, and `command` would wait up to seconds for a socket.
        let mut ipc = Ipc::try_connect(&self.socket).ok()?;
        let metadata = ipc
            .request(&[
                serde_json::json!("get_property"),
                serde_json::json!("af-metadata/lilolevel"),
            ])
            .ok()?;
        parse_levels(&metadata)
    }

    pub fn status(&mut self) -> NowPlaying {
        if !self.is_running() {
            let mut snapshot = self.snapshot();
            snapshot.queue_length = 0;
            return snapshot;
        }
        self.sync_position();
        self.snapshot()
    }

    fn snapshot(&self) -> NowPlaying {
        let current = self.queue.get(self.position);
        NowPlaying {
            title: current.map(|t| t.title.clone()).unwrap_or_default(),
            artist: current.map(|t| t.artist.clone()).unwrap_or_default(),
            url: current.map(|t| t.url.clone()).unwrap_or_default(),
            artwork_url: current.and_then(|t| t.artwork_url.clone()),
            // What is left, current track included: the player hides itself
            // at zero.
            queue_length: self.queue.len().saturating_sub(self.position),
            paused: self.paused,
            volume: self.volume,
        }
    }
}

impl Drop for MpvPlayer {
    /// mpv must never outlive the app: an orphaned player keeps playing with no
    /// way to stop it.
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn astats_metadata_becomes_levels() {
        // Captured from mpv 0.40 playing a 440 Hz sine.
        let sine = serde_json::json!({
            "lavfi.astats.Overall.Max_level": "4095.000000",
            "lavfi.astats.Overall.Min_level": "-4095.000000",
            "lavfi.astats.Overall.Peak_level": "-18.063656",
            "lavfi.astats.Overall.RMS_level": "-21.119562",
            "lavfi.astats.Overall.RMS_difference": "182.434852"
        });
        let levels = super::parse_levels(&sine).unwrap();
        assert!(levels.level > 0.6 && levels.level < 0.75, "{levels:?}");
        assert!(
            levels.high < 0.2 * levels.level + 0.05,
            "a low tone is not bright: {levels:?}"
        );
        assert!(levels.low > levels.high);

        let silence = serde_json::json!({ "lavfi.astats.Overall.RMS_level": "-inf" });
        assert_eq!(super::parse_levels(&silence).unwrap().level, 0.0);
        assert!(super::parse_levels(&serde_json::json!({})).is_none());
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn commands_encode_as_line_delimited_json() {
        let line = encode_command(&[json!("set_property"), json!("pause"), json!(true)], 7);
        assert_eq!(
            line,
            "{\"command\":[\"set_property\",\"pause\",true],\"request_id\":7}\n"
        );
        assert!(line.ends_with('\n'), "mpv IPC is line delimited");
    }

    #[test]
    fn a_successful_reply_yields_its_data() {
        let reply = r#"{"data":42,"error":"success","request_id":3}"#;
        let value = parse_response(reply, 3).unwrap().unwrap();
        assert_eq!(value, json!(42));
    }

    #[test]
    fn a_reply_for_another_request_is_skipped() {
        let reply = r#"{"data":1,"error":"success","request_id":9}"#;
        assert!(parse_response(reply, 3).is_none());
    }

    #[test]
    fn unsolicited_events_are_skipped() {
        // mpv interleaves these with replies; treating one as an answer would
        // desynchronise every later command.
        assert!(parse_response(r#"{"event":"playback-restart"}"#, 1).is_none());
        assert!(parse_response("not json at all", 1).is_none());
    }

    #[test]
    fn an_error_reply_becomes_an_error() {
        let reply = r#"{"error":"property not found","request_id":2}"#;
        let err = parse_response(reply, 2).unwrap().unwrap_err();
        assert!(err.to_string().contains("property not found"));
    }

    #[test]
    fn ducking_scales_the_current_volume() {
        assert_eq!(ducked_volume(80, 25), 20);
        assert_eq!(ducked_volume(70, 0), 0);
        assert_eq!(ducked_volume(70, 100), 70);
        assert_eq!(ducked_volume(0, 25), 0);
    }

    #[test]
    fn mpv_arguments_stay_inside_a_small_board_budget() {
        assert!(MPV_ARGS.contains(&"--no-video"));
        assert!(MPV_ARGS
            .iter()
            .any(|a| a.starts_with("--demuxer-max-bytes")));
    }

    #[test]
    fn quality_only_caps_the_bitrate_when_asked() {
        // The 128 kbps cap is a small-board constraint; applying it everywhere
        // made desktop playback sound worse for no reason.
        assert!(ytdl_format("low").contains("abr<=?128"));
        assert!(!ytdl_format("high").contains("abr"));
        assert!(!ytdl_format("").contains("abr"), "default must not cap");
        assert!(ytdl_format("high").contains("vcodec=none"));
    }

    #[test]
    fn playing_nothing_is_an_error_not_a_spawn() {
        let mut player = MpvPlayer::new(PathBuf::from("/definitely/not/mpv"));
        let err = player.play(Vec::new(), 70).unwrap_err();
        assert!(err.to_string().contains("nothing to play"));
    }

    #[test]
    fn controls_fail_cleanly_when_nothing_is_playing() {
        let mut player = MpvPlayer::new(PathBuf::from("/definitely/not/mpv"));
        assert!(!player.is_running());
        assert!(player
            .pause()
            .unwrap_err()
            .to_string()
            .contains("nothing is playing"));
        assert!(
            player.duck(true, 25).is_ok(),
            "ducking must be a safe no-op"
        );
        assert_eq!(player.status().queue_length, 0);
        assert!(player.current().is_none());
        assert!(player
            .append(Vec::new(), true)
            .unwrap_err()
            .to_string()
            .contains("nothing is playing"));
        assert!(player.stop().is_ok());
    }

    /// Find mpv without going through settings, so this test can run wherever
    /// mpv happens to be installed.
    fn find_mpv() -> Option<PathBuf> {
        let managed = dirs_data()
            .map(|d| d.join("bin/mpv/mpv-arm64-0.40.0/mpv.app/Contents/MacOS/mpv"))
            .filter(|p| p.is_file());
        managed.or_else(|| super::super::binaries::locate("mpv", ""))
    }

    fn dirs_data() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join("Library/Application Support/com.lilo.app"))
    }

    /// The safety property that matters: if the app dies without cleaning up,
    /// mpv must stop on its own. Nothing here removes the process — the Lua
    /// watchdog inside mpv does, because the heartbeat stops being refreshed.
    #[test]
    fn the_heartbeat_keeps_ticking() {
        let path = std::env::temp_dir().join(format!(
            "{IPC_MARKER}beat-test-{}.alive",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let beat = Heartbeat::start(path.clone());
        std::thread::sleep(Duration::from_millis(2500));
        let age = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .map(|mtime| {
                std::time::SystemTime::now()
                    .duration_since(mtime)
                    .unwrap_or_default()
            })
            .unwrap_or(Duration::MAX);
        beat.stop();
        let _ = std::fs::remove_file(&path);
        assert!(
            age < Duration::from_millis(1500),
            "heartbeat went stale after {age:?}; mpv would quit on its own"
        );
    }

    #[test]
    fn mpv_quits_itself_when_the_parent_stops_beating() {
        let Some(mpv) = find_mpv() else {
            eprintln!("mpv not installed here; skipping watchdog test");
            return;
        };

        let token = format!("{IPC_MARKER}watchdog-{}", std::process::id());
        let tmp = std::env::temp_dir();
        let heartbeat = tmp.join(format!("{token}.alive"));
        let script = tmp.join(format!("{token}.lua"));
        std::fs::write(&script, WATCHDOG_LUA).unwrap();
        // Written once and then deliberately never refreshed: this is what a
        // SIGKILLed parent looks like to mpv.
        std::fs::write(&heartbeat, b"").unwrap();

        let mut child = std::process::Command::new(&mpv)
            .args(["--no-video", "--no-terminal", "--idle=yes", "--volume=0"])
            .arg(format!(
                "--script-opts=lilo-heartbeat={},lilo-heartbeat-timeout={HEARTBEAT_TIMEOUT_SECS}",
                heartbeat.display()
            ))
            .arg(format!("--script={}", script.display()))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("mpv must start");

        // --idle=yes means mpv would otherwise stay up forever.
        let deadline = Instant::now() + Duration::from_secs(HEARTBEAT_TIMEOUT_SECS + 15);
        let mut exited = false;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        if !exited {
            let _ = child.kill();
        }
        let _ = child.wait();
        let _ = std::fs::remove_file(&heartbeat);
        let _ = std::fs::remove_file(&script);

        assert!(
            exited,
            "mpv must quit on its own once the heartbeat goes stale — otherwise \
             a killed app leaves music playing with nothing able to stop it"
        );
    }

    #[test]
    fn the_watchdog_script_reads_the_options_we_pass() {
        // A rename on either side silently disables the watchdog.
        assert!(WATCHDOG_LUA.contains("lilo-heartbeat"));
        assert!(WATCHDOG_LUA.contains("lilo-heartbeat-timeout"));
        assert!(WATCHDOG_LUA.contains("quit"));
    }

    /// mpv rejects an unknown option *before* playing, so a typo turns every
    /// play into an instant `Fatal error` (`--log-file-level` did exactly
    /// that). Ask the real binary which options exist instead of trusting the
    /// manual.
    #[test]
    fn every_option_we_pass_to_mpv_exists() {
        let Some(mpv) = find_mpv() else {
            eprintln!("mpv not installed here; skipping option-name test");
            return;
        };
        let output = std::process::Command::new(&mpv)
            .arg("--list-options")
            .output()
            .expect("mpv --list-options must run");
        let known: std::collections::HashSet<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().strip_prefix("--"))
            .filter_map(|line| line.split([' ', '=']).next())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect();

        // Built inline in `play()`, so they are spelled out here.
        let dynamic = [
            "ytdl-format=best",
            "volume=70",
            "input-ipc-server=x",
            "log-file=x",
            "script-opts=x",
            "script=x",
        ];
        for arg in MPV_ARGS.iter().copied().chain(dynamic) {
            let name = arg.trim_start_matches("--").split('=').next().unwrap_or("");
            let base = name.strip_prefix("no-").unwrap_or(name);
            assert!(
                known.contains(name) || known.contains(base),
                "mpv does not know the option --{name}"
            );
        }
    }

    #[test]
    fn reaping_clears_stale_sockets() {
        // A killed app leaves its IPC socket behind; they would otherwise pile
        // up in the temp directory forever.
        let stale =
            std::env::temp_dir().join(format!("{IPC_MARKER}test-{}.sock", std::process::id()));
        std::fs::write(&stale, b"").unwrap();
        assert!(stale.exists());
        reap_orphans();
        assert!(!stale.exists(), "a stale socket must be removed");
    }

    #[test]
    fn reaping_leaves_unrelated_files_alone() {
        let other = std::env::temp_dir().join(format!("not-ours-{}.sock", std::process::id()));
        std::fs::write(&other, b"").unwrap();
        reap_orphans();
        assert!(other.exists(), "only our own sockets may be touched");
        let _ = std::fs::remove_file(other);
    }

    #[test]
    fn every_ipc_path_carries_the_marker() {
        // Reaping finds players by this marker; a path without it would be
        // unkillable after a crash.
        assert!(ipc_path("abc").to_string_lossy().contains(IPC_MARKER));
    }

    #[test]
    fn a_missing_binary_reports_instead_of_panicking() {
        let mut player = MpvPlayer::new(PathBuf::from("/definitely/not/mpv"));
        let track = super::super::resolver::Track {
            id: "x".into(),
            title: "T".into(),
            artist: "A".into(),
            url: "https://example.invalid/a.m4a".into(),
            duration_secs: None,
            artwork_url: None,
        };
        let err = player.play(vec![track], 70).unwrap_err();
        assert!(err.to_string().contains("could not start mpv"));
    }

    /// Real mpv: levels flow while a track plays.
    ///   cargo test -p lilo-core -- --ignored live_levels --nocapture
    #[test]
    #[ignore = "needs mpv"]
    fn live_levels_from_a_playing_track() {
        let bin = std::path::PathBuf::from(std::env::var("MPV_BIN").expect("MPV_BIN"));
        let mut player = super::MpvPlayer::new(bin);
        let track = super::super::resolver::Track {
            id: "sine".into(),
            title: "sine".into(),
            artist: "test".into(),
            url: "av://lavfi:sine=frequency=440:duration=8".into(),
            duration_secs: Some(8),
            artwork_url: None,
        };
        player.play(vec![track], 0).expect("plays");
        std::thread::sleep(std::time::Duration::from_millis(800));
        let mut readings = Vec::new();
        for _ in 0..5 {
            readings.push(player.levels());
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        eprintln!("{readings:?}");
        player.stop().ok();
        assert!(
            readings.iter().any(|r| r.is_some_and(|l| l.level > 0.3)),
            "{readings:?}"
        );
    }
}
