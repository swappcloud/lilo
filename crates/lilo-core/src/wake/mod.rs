//! Local wake listening shared by Linux desktop and headless hosts.
//! Audio stays on the device; this module emits state and detections, not text.

use std::path::PathBuf;
#[cfg(not(target_os = "linux"))]
use std::sync::mpsc::SyncSender;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::WakeListener;

#[derive(Clone, Debug)]
pub struct Options {
    pub phrase: String,
    /// Finite local command phrases supplied by the command registry.
    pub command_phrases: Vec<String>,
    pub state_dir: PathBuf,
    pub model_dir: PathBuf,
    pub library_dir: Option<PathBuf>,
    pub capture_binary: PathBuf,
}

impl Options {
    pub fn new(phrase: &str, state_dir: PathBuf) -> Self {
        Self {
            phrase: phrase.trim().to_lowercase(),
            command_phrases: Vec::new(),
            state_dir,
            model_dir: PathBuf::from("/usr/share/pocketsphinx/model/en-us"),
            library_dir: None,
            capture_binary: PathBuf::from("parec"),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.phrase.is_empty()
            || self.phrase.len() > 80
            || self.phrase.split_whitespace().count() > 16
            || !self
                .phrase
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b' ' || b == b'\'')
        {
            return Err("The Linux wake phrase must contain supported dictionary words.".into());
        }
        if self.command_phrases.len() > 256
            || self.command_phrases.iter().map(String::len).sum::<usize>() > 16_384
        {
            return Err("The local voice command catalog is too large.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Ready,
    Detected,
    /// A catalog phrase recognized locally, without starting provider voice.
    LocalCommand(String),
    Blocked {
        reason: &'static str,
        detail: &'static str,
    },
}

#[cfg(not(target_os = "linux"))]
pub struct WakeListener;

#[cfg(not(target_os = "linux"))]
impl WakeListener {
    pub fn start(options: Options, _events: SyncSender<Event>) -> Result<Self, String> {
        options.validate()?;
        Err("The shared local wake engine is available on Linux only.".into())
    }
    pub fn is_running(&self) -> bool {
        false
    }
    pub fn stop(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phrases_are_bounded_before_native_code_or_process_startup() {
        let valid = Options::new("Hello LILO", PathBuf::from("fixture"));
        assert_eq!(valid.phrase, "hello lilo");
        assert!(valid.validate().is_ok());
        for phrase in ["", "lilo\n", "$(command)", "lilo; command", "lilo\0"] {
            let mut options = valid.clone();
            options.phrase = phrase.into();
            assert!(options.validate().is_err());
        }
        assert!(Options::new(&"a".repeat(81), PathBuf::new())
            .validate()
            .is_err());
    }
}
