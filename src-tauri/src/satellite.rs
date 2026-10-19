//! Driving a live ChatGPT session without a microphone.
//!
//! The satellite (docs/command-protocol.md §9): only a webview can hold the ChatGPT
//! session, so a headless box — the Pi, a container — talks to the desktop over
//! the LAN and the desktop does the talking. The contract both ends speak is
//! `lilo_core::satellite` (length-prefixed PCM16 frames); this module is the
//! desktop's half:
//!
//! ```text
//! client → desktop   hello, activate, audio_in
//! desktop → client   audio_out, bye
//! ```
//!
//! The frontend seam is already there: `audio_in` becomes the same
//! `satellite-audio` event the file-driven test uses, `activate` becomes the
//! event the appliance's physical button will emit, and the assistant's audio
//! comes back through `satellite_audio_out`. A file fallback
//! (`LILO_SATELLITE_IN`/`LILO_SATELLITE_OUT`) stays for testing with no client.

use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use lilo_core::satellite::{
    encode, read_frame, read_wav as core_read_wav, wav_header, CHUNK_SAMPLES, KIND_ACTIVATE,
    KIND_AUDIO_IN, KIND_AUDIO_OUT, KIND_BYE, KIND_HELLO, KIND_READY, RATE,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::logging;

/// The model has just joined when the feed starts; a short pause first is what
/// a person would leave, and avoids clipping the phrase.
const LEAD_IN_MS: u64 = 700;

/// What the environment asked for.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// A phrase file to feed in, when no client is connected.
    pub input: Option<PathBuf>,
    /// A file to write the assistant's audio to, alongside any client.
    pub output: Option<PathBuf>,
    /// The LAN link a headless client connects to.
    pub port: Option<u16>,
    pub key: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let path = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let port = std::env::var("LILO_SATELLITE_PORT")
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok());
        let key = std::env::var("LILO_SATELLITE_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            input: path("LILO_SATELLITE_IN"),
            output: path("LILO_SATELLITE_OUT"),
            port,
            key,
        }
    }

    pub fn active(&self) -> bool {
        self.input.is_some() || self.output.is_some() || self.port.is_some()
    }

    /// The pairing key, generated when the port is set without one: a test
    /// seam on a LAN still should not accept whoever connects first.
    pub fn key(&self) -> Option<String> {
        self.port.as_ref()?;
        Some(
            self.key
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()[..12].to_string()),
        )
    }
}

/// The answer being written down, while a session is live.
struct Recording {
    file: std::fs::File,
    bytes: u32,
}

/// What the frontend asks for before a session starts.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SatelliteInfo {
    /// Drive the session from outside instead of using a microphone.
    pub input: bool,
    /// Send the assistant's audio out.
    pub output: bool,
    /// Feed a phrase file from Rust; false when a client does the feeding.
    pub feed: bool,
}

/// A connected headless client, as a sink for frames.
struct Peer {
    frames: mpsc::UnboundedSender<(u8, Vec<u8>)>,
}

/// The satellite seam, one per app.
#[derive(Default)]
pub struct Satellite {
    config: Config,
    recording: Mutex<Option<Recording>>,
    peer: Mutex<Option<Peer>>,
    /// The frontend says when the session is connected: audio that arrives
    /// before that is held, not dropped. A client cannot know how long the
    /// hidden webview takes to bring a session up.
    ready: AtomicBool,
    /// Up to a few seconds of audio waiting for `ready`.
    held: Mutex<Vec<Vec<u8>>>,
}

/// How much audio to hold for a session that is still connecting: 8 s of
/// 40 ms chunks, a whole phrase, bounded so a rogue client cannot grow it.
const MAX_HELD_CHUNKS: usize = 200;

impl Satellite {
    pub fn new(config: Config) -> Self {
        if config.active() {
            logging::log(
                "satellite",
                &format!(
                    "seam active: port={:?} in={:?} out={:?}",
                    config.port, config.input, config.output
                ),
            );
        }
        Self {
            config,
            recording: Mutex::new(None),
            peer: Mutex::new(None),
            ready: AtomicBool::new(false),
            held: Mutex::new(Vec::new()),
        }
    }

    pub fn info(&self) -> Option<SatelliteInfo> {
        self.config.active().then(|| SatelliteInfo {
            input: self.config.input.is_some() || self.config.port.is_some(),
            output: self.config.output.is_some() || self.config.port.is_some(),
            feed: self.config.input.is_some(),
        })
    }

    pub fn port(&self) -> Option<u16> {
        self.config.port
    }

    pub fn key(&self) -> Option<String> {
        self.config.key()
    }

    pub fn output_path(&self) -> Option<PathBuf> {
        self.config.output.clone()
    }

    /// Whether a headless client is on the line right now.
    pub fn connected(&self) -> bool {
        self.peer.lock().map(|peer| peer.is_some()).unwrap_or(false)
    }

    fn send(&self, kind: u8, payload: Vec<u8>) {
        let peer = self
            .peer
            .lock()
            .ok()
            .and_then(|peer| peer.as_ref().map(|peer| peer.frames.clone()));
        if let Some(frames) = peer {
            let _ = frames.send((kind, payload));
        }
    }
}

/// Read a 16 kHz mono PCM16 WAV through the shared contract.
pub fn read_wav(path: &std::path::Path) -> lilo_core::Result<Vec<i16>> {
    core_read_wav(path)
}

/// Accept headless clients until the app exits.
pub async fn serve(app: AppHandle, port: u16, key: String) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            logging::log("satellite", &format!("could not listen on {port}: {error}"));
            return;
        }
    };
    logging::log(
        "satellite",
        &format!("listening on 0.0.0.0:{port} (key {key})"),
    );
    loop {
        match listener.accept().await {
            Ok((socket, from)) => {
                logging::log("satellite", &format!("client from {from}"));
                let app = app.clone();
                let key = key.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = handle_client(app, socket, key).await {
                        logging::log("satellite", &format!("client dropped: {error}"));
                    }
                });
            }
            Err(error) => {
                logging::log("satellite", &format!("accept failed: {error}"));
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// One client: pairing first, then whatever it sends.
async fn handle_client(app: AppHandle, mut socket: TcpStream, key: String) -> std::io::Result<()> {
    let Some((kind, payload)) = read_frame(&mut socket).await? else {
        return Ok(());
    };
    if kind != KIND_HELLO || payload != key.as_bytes() {
        logging::log("satellite", "client refused: wrong pairing key");
        return Ok(());
    }

    let (frames, mut outgoing) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    {
        // The guard's temporary has to go before `state` does, so it is bound.
        let state = app.state::<crate::AppState>();
        let locked = state.satellite.peer.lock();
        if let Ok(mut peer) = locked {
            *peer = Some(Peer { frames });
        }
    }

    let (mut read, mut write) = socket.into_split();
    let writer = tauri::async_runtime::spawn(async move {
        while let Some((kind, payload)) = outgoing.recv().await {
            if write.write_all(&encode(kind, &payload)).await.is_err() {
                break;
            }
        }
    });

    while let Some((kind, payload)) = read_frame(&mut read).await? {
        match kind {
            KIND_ACTIVATE => {
                logging::log("satellite", "activate (button)");
                let _ = app.emit("satellite-activate", ());
            }
            KIND_AUDIO_IN => {
                let state = app.state::<crate::AppState>();
                if state.satellite.ready.load(Ordering::Relaxed) {
                    emit_audio(&app, &payload);
                } else {
                    // The session is still coming up; hold the phrase rather
                    // than throwing it away.
                    let locked = state.satellite.held.lock();
                    if let Ok(mut held) = locked {
                        if held.len() < MAX_HELD_CHUNKS {
                            held.push(payload);
                        }
                    }
                }
            }
            KIND_BYE => break,
            other => {
                logging::log("satellite", &format!("ignoring frame kind {other}"));
            }
        }
    }

    {
        let state = app.state::<crate::AppState>();
        let locked = state.satellite.peer.lock();
        if let Ok(mut peer) = locked {
            *peer = None;
        }
        state.satellite.ready.store(false, Ordering::Relaxed);
        let locked = state.satellite.held.lock();
        if let Ok(mut held) = locked {
            held.clear();
        }
    }
    writer.abort();
    logging::log("satellite", "client disconnected");
    Ok(())
}

/// The frontend turns a chunk into `sendAudio`, exactly like the file-driven
/// feed: one seam, two sources.
fn emit_audio(app: &AppHandle, payload: &[u8]) {
    let chunk = base64::engine::general_purpose::STANDARD.encode(payload);
    let _ = app.emit("satellite-audio", chunk);
}

/// The session is connected and listening: flush whatever the client sent while
/// it was coming up, and tell the client it may speak.
#[tauri::command]
pub fn satellite_ready(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.satellite.ready.store(true, Ordering::Relaxed);
    let held = state
        .satellite
        .held
        .lock()
        .map(|mut held| std::mem::take(&mut *held))
        .unwrap_or_default();
    if !held.is_empty() {
        logging::log("satellite", &format!("flushing {} held chunks", held.len()));
    }
    for payload in held {
        emit_audio(&app, &payload);
    }
    if state.satellite.connected() {
        state.satellite.send(KIND_READY, Vec::new());
        logging::log("satellite", "told the client the session is ready");
    }
    Ok(())
}

#[tauri::command]
pub fn satellite_config(state: tauri::State<'_, crate::AppState>) -> Option<SatelliteInfo> {
    state.satellite.info()
}

/// The physical button: pressing it asks for a session. The appliance will call
/// exactly this when its button is pressed.
#[tauri::command]
pub fn satellite_activate(app: AppHandle) -> Result<(), String> {
    logging::log("satellite", "activation requested (button)");
    app.emit("satellite-activate", ())
        .map_err(|error| error.to_string())
}

/// Start feeding a phrase file into the session, when the environment named
/// one. A connected client feeds its own audio instead.
#[tauri::command]
pub async fn satellite_start_input(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let Some(path) = state.satellite.config.input.clone() else {
        return Err("LILO_SATELLITE_IN is not set".to_string());
    };
    let samples = read_wav(&path).map_err(|error| error.to_string())?;
    logging::log(
        "satellite",
        &format!(
            "feeding {} — {:.1}s of audio",
            path.display(),
            samples.len() as f32 / RATE as f32
        ),
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(LEAD_IN_MS)).await;
        for chunk in samples.chunks(CHUNK_SAMPLES) {
            let payload = lilo_core::satellite::samples_to_bytes(chunk);
            let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
            if app.emit("satellite-audio", encoded).is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        let _ = app.emit("satellite-input-done", ());
        logging::log("satellite", "phrase sent");
    });
    Ok(())
}

/// One chunk of the assistant's audio, base64 PCM16: out to the client, and to
/// the file when one was named.
#[tauri::command]
pub fn satellite_audio_out(
    state: tauri::State<'_, crate::AppState>,
    chunk: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk)
        .map_err(|error| format!("not base64: {error}"))?;

    if state.satellite.connected() {
        state.satellite.send(KIND_AUDIO_OUT, bytes.clone());
    }

    let Some(path) = state.satellite.output_path() else {
        return Ok(());
    };
    let mut recording = state
        .satellite
        .recording
        .lock()
        .map_err(|_| "the satellite recorder is poisoned".to_string())?;
    if recording.is_none() {
        let mut file = std::fs::File::create(&path)
            .map_err(|error| format!("could not create {}: {error}", path.display()))?;
        file.write_all(&wav_header(0))
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        logging::log(
            "satellite",
            &format!("recording the answer to {}", path.display()),
        );
        *recording = Some(Recording { file, bytes: 0 });
    }
    let recording = recording.as_mut().expect("just created");
    if let Err(error) = recording.file.write_all(&bytes) {
        logging::log("satellite", &format!("write failed: {error}"));
        return Ok(());
    }
    recording.bytes += bytes.len() as u32;
    Ok(())
}

/// The session is over: tell the client, close the recording, fix its sizes.
#[tauri::command]
pub fn satellite_finish_output(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    if state.satellite.connected() {
        state.satellite.send(KIND_BYE, Vec::new());
    }
    let Some(mut recording) = state
        .satellite
        .recording
        .lock()
        .map_err(|_| "the satellite recorder is poisoned".to_string())?
        .take()
    else {
        return Ok(());
    };
    recording
        .file
        .seek(SeekFrom::Start(0))
        .and_then(|_| recording.file.write_all(&wav_header(recording.bytes)))
        .map_err(|error| format!("could not close the recording: {error}"))?;
    logging::log(
        "satellite",
        &format!(
            "answer recorded: {:.1}s",
            recording.bytes as f32 / (RATE as f32 * 2.0)
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_generated_when_only_the_port_is_configured() {
        let config = Config {
            port: Some(4599),
            ..Config::default()
        };
        let key = config.key().expect("a key");
        assert_eq!(key.len(), 12);

        let explicit = Config {
            port: Some(4599),
            key: Some("segredo".to_string()),
            ..Config::default()
        };
        assert_eq!(explicit.key().as_deref(), Some("segredo"));
    }

    #[test]
    fn the_link_reports_itself_as_input_and_output_but_not_as_a_file_feed() {
        let config = Config {
            port: Some(4599),
            ..Config::default()
        };
        let info = Satellite::new(config).info().expect("active");
        assert!(info.input && info.output);
        assert!(!info.feed, "a client feeds, not a file");
    }
}
