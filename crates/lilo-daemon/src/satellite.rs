//! The Pi side of the satellite link: send what was heard, play back what
//! the assistant says.
//!
//! Today "what was heard" is a WAV file — the container and the board have no
//! microphone wired into LILO yet — and "what the assistant says" is written to
//! another WAV. The transport and the frames are the real ones
//! (`lilo_core::satellite`), so wake word and STT only have to replace the file
//! on the reading side and an audio device on the writing side.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lilo_core::satellite::{
    encode, read_frame, read_wav, samples_to_bytes, wav_header, CHUNK_SAMPLES, KIND_ACTIVATE,
    KIND_AUDIO_IN, KIND_AUDIO_OUT, KIND_BYE, KIND_HELLO, KIND_READY, RATE,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::log;

/// The model has just joined when the phrase starts; a short pause first is
/// what a person would leave, and avoids clipping the first word.
const LEAD_IN_MS: u64 = 700;
/// How long a silence in the answer means the session is over.
const QUIET_SECS: u32 = 8;
/// Hard cap on waiting for the answer, so a wedged session cannot hang the box.
const MAX_WAIT_SECS: u32 = 120;
/// How long to wait for the desktop's `ready` before speaking anyway.
const WAIT_READY_SECS: u64 = 30;

pub struct Client {
    /// The paired desktop, `host:port`.
    pub addr: String,
    pub key: String,
    pub phrase: PathBuf,
    pub answer: PathBuf,
}

impl Client {
    /// Connect, press the button, speak the phrase, write down the answer.
    pub async fn run(&self) -> anyhow::Result<()> {
        let samples = read_wav(&self.phrase)?;
        let seconds = samples.len() as f32 / RATE as f32;
        log::info(format!("phrase: {} ({seconds:.1}s)", self.phrase.display()));

        let mut socket = TcpStream::connect(&self.addr).await?;
        socket
            .write_all(&encode(KIND_HELLO, self.key.as_bytes()))
            .await?;
        // The physical button, from the box's point of view.
        socket.write_all(&encode(KIND_ACTIVATE, &[])).await?;
        log::info(format!("connected to {} — activation sent", self.addr));

        let (mut read, mut write) = socket.into_split();
        let heard: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
        let (bye_tx, mut bye_rx) = tokio::sync::oneshot::channel::<()>();
        let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel::<()>();

        {
            let heard = heard.clone();
            tokio::spawn(async move {
                let mut bye_tx = Some(bye_tx);
                let mut ready_tx = Some(ready_tx);
                while let Ok(Some((kind, payload))) = read_frame(&mut read).await {
                    match kind {
                        KIND_READY => {
                            if let Some(ready) = ready_tx.take() {
                                let _ = ready.send(());
                            }
                        }
                        KIND_AUDIO_OUT => {
                            if let Ok(mut heard) = heard.lock() {
                                heard.extend(lilo_core::satellite::bytes_to_samples(&payload));
                            }
                        }
                        KIND_BYE => break,
                        _ => {}
                    }
                }
                if let Some(bye) = bye_tx.take() {
                    let _ = bye.send(());
                }
            });
        }

        // Speak only once the desktop says its session is listening: the
        // hidden webview takes seconds to come up, and a phrase sent into that
        // gap is a phrase the model never hears.
        tokio::select! {
            _ = &mut ready_rx => log::info("session ready — speaking"),
            _ = tokio::time::sleep(Duration::from_secs(WAIT_READY_SECS)) => {
                log::warn("no ready from the desktop; speaking anyway");
            }
        }
        tokio::time::sleep(Duration::from_millis(LEAD_IN_MS)).await;
        for chunk in samples.chunks(CHUNK_SAMPLES) {
            write
                .write_all(&encode(KIND_AUDIO_IN, &samples_to_bytes(chunk)))
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        log::info("phrase sent — waiting for the answer");

        let mut idle = 0;
        let mut last = 0usize;
        for _ in 0..MAX_WAIT_SECS {
            tokio::select! {
                _ = &mut bye_rx => break,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    let now = heard.lock().map(|heard| heard.len()).unwrap_or(0);
                    if now == last {
                        idle += 1;
                        if idle >= QUIET_SECS { break; }
                    } else {
                        idle = 0;
                        last = now;
                    }
                }
            }
        }

        let heard = heard.lock().map(|heard| heard.clone()).unwrap_or_default();
        let seconds = heard.len() as f32 / RATE as f32;
        if heard.is_empty() {
            log::warn("no audio came back");
            return Ok(());
        }
        let mut file = std::fs::File::create(&self.answer)?;
        file.write_all(&wav_header(samples_to_bytes(&heard).len() as u32))?;
        file.write_all(&samples_to_bytes(&heard))?;
        log::info(format!(
            "answer: {} ({seconds:.1}s) — {}",
            self.answer.display(),
            if seconds > 0.2 {
                "the assistant spoke"
            } else {
                "a blip only"
            }
        ));
        Ok(())
    }
}
