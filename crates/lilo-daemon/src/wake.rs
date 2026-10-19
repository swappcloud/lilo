//! Daemon wake lifecycle; provider and account selection stay in Session.
use lilo_core::wake::{Event, Options, WakeListener};
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

pub struct WakeController {
    listener: Option<WakeListener>,
    events: Option<Receiver<Event>>,
    phrase: String,
    state: &'static str,
    retry_after: Option<Instant>,
    login_until: Option<Instant>,
    detections: u64,
}
impl WakeController {
    pub fn new() -> Self {
        Self {
            listener: None,
            events: None,
            phrase: String::new(),
            state: "off",
            retry_after: None,
            login_until: None,
            detections: 0,
        }
    }
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"state": self.state, "detections": self.detections})
    }
    pub fn pause(&mut self) {
        self.listener.take();
        self.events = None;
        self.state = "off";
    }
    pub fn voice_started(&mut self) {
        // A successful connection no longer needs the failed-start backoff.
        self.retry_after = None;
        self.login_until = None;
    }
    pub fn voice_stopped(&mut self) {
        self.pause();
        // Let the provider's final speaker buffer drain before wake capture.
        self.retry_after = Some(Instant::now() + Duration::from_secs(2));
        self.login_until = None;
    }
    pub fn pause_for_login(&mut self) {
        self.pause();
        // Active phone sign-in polling renews this delay without opening the mic.
        self.login_until = Some(Instant::now() + Duration::from_secs(30));
    }
    pub fn update(&mut self, enabled: bool, ready: bool, phrase: &str, data_dir: &Path) -> bool {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (enabled, ready, phrase, data_dir);
            return false;
        }
        #[cfg(target_os = "linux")]
        {
            if !enabled || !ready || self.login_until.is_some_and(|until| Instant::now() < until) {
                self.pause();
                return false;
            }
            if self.phrase != phrase {
                self.pause();
                self.retry_after = None;
                self.phrase = phrase.into();
            }
            if self.listener.is_none()
                && !self.retry_after.is_some_and(|until| Instant::now() < until)
            {
                let (send, receive) = mpsc::sync_channel(8);
                match WakeListener::start(Options::new(phrase, data_dir.join("wake")), send) {
                    Ok(listener) => {
                        self.listener = Some(listener);
                        self.events = Some(receive);
                        self.state = "starting";
                    }
                    Err(_) => {
                        self.state = "blocked";
                        self.retry_after = Some(Instant::now() + Duration::from_secs(30));
                    }
                }
            }
            let mut detected = false;
            let mut blocked = false;
            if let Some(events) = self.events.as_ref() {
                for event in events.try_iter() {
                    match event {
                        Event::Ready => self.state = "listening",
                        Event::Detected => detected = true,
                        Event::Blocked { .. } => blocked = true,
                    }
                }
            }
            if blocked {
                self.pause();
                self.state = "blocked";
                self.retry_after = Some(Instant::now() + Duration::from_secs(30));
            }
            if detected {
                self.detections = self.detections.saturating_add(1);
                self.pause();
                self.retry_after = Some(Instant::now() + Duration::from_secs(30));
            }
            detected && !blocked
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn successful_voice_handoff_does_not_keep_the_failed_start_backoff() {
        let mut wake = WakeController::new();
        wake.retry_after = Some(Instant::now() + Duration::from_secs(30));
        wake.login_until = wake.retry_after;
        wake.voice_started();
        assert!(wake.retry_after.is_none());
        assert!(wake.login_until.is_none());
        wake.voice_stopped();
        let delay = wake
            .retry_after
            .unwrap()
            .saturating_duration_since(Instant::now());
        assert!(delay <= Duration::from_secs(2));
        assert_eq!(wake.status()["state"], "off");
    }
    #[test]
    fn disabled_and_in_call_hosts_never_start_a_microphone_process() {
        let mut wake = WakeController::new();
        assert!(!wake.update(false, true, "lilo", Path::new("fixture")));
        assert_eq!(wake.status()["state"], "off");
        assert!(!wake.update(true, false, "lilo", Path::new("fixture")));
        wake.pause_for_login();
        assert!(!wake.update(true, true, "lilo", Path::new("fixture")));
        assert!(wake.listener.is_none());
    }
}
