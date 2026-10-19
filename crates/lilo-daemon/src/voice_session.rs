//! Connect provider captions and controls to the daemon's existing command host.

use super::{now_ms, Session};
use crate::log;
use crate::voice::{VoiceSpeaker, VoiceState, VoiceStatus};
use anyhow::Context;
use lilo_core::plugins;

fn remember_voice_turn(
    turns: &mut std::collections::VecDeque<(VoiceSpeaker, String)>,
    speaker: VoiceSpeaker,
    id: &str,
) -> bool {
    if turns
        .iter()
        .any(|(seen_speaker, seen_id)| *seen_speaker == speaker && seen_id == id)
    {
        return false;
    }
    turns.push_back((speaker, id.to_owned()));
    if turns.len() > 128 {
        turns.pop_front();
    }
    true
}

fn session_context_payload(status: &VoiceStatus) -> serde_json::Value {
    let connected = status.state == VoiceState::Connected && status.session_id.is_some();
    let state = match status.state {
        VoiceState::Idle => "disconnected",
        VoiceState::Starting => "connecting",
        VoiceState::Connected if connected => "connected",
        VoiceState::Connected => "disconnected",
        VoiceState::Error => "error",
    };
    serde_json::json!({
        "sessionId": if connected { status.session_id.as_deref() } else { None },
        "supportLanguage": null,
        "state": state,
        "provider": if connected { serde_json::json!({
            "inbound":{"userText":true,"assistantText":true,"nativeToolCalls":false,"images":false},
            "outbound":{"text":true,"stopSpeaking":true,"systemPrompt":true,"toolResult":false,"image":false}
        }) } else { serde_json::Value::Null }
    })
}

impl Session {
    pub async fn poll_wake(&mut self) {
        let provider = self.settings.get().provider_id;
        let idle = self.voice.as_ref().is_some_and(|voice| {
            voice.providers().contains(&provider)
                && matches!(
                    voice.status().state,
                    crate::voice::VoiceState::Idle | crate::voice::VoiceState::Error
                )
        });
        let account = self.accounts.pick(&provider, None);
        if self.wake.update(
            self.device.wake_word,
            idle && account.is_some(),
            &self.device.wake_phrase,
            &self.data_dir,
        ) {
            if let Some(account) = account {
                if self
                    .start_voice(&provider, &account.email, None)
                    .await
                    .is_err()
                {
                    crate::log::warn(
                        "wake activation could not start the selected provider session",
                    );
                }
            }
        }
    }
    pub async fn start_voice(
        &mut self,
        provider: &str,
        email: &str,
        resolved_language: Option<String>,
    ) -> anyhow::Result<serde_json::Value> {
        let account = self
            .accounts
            .get_by_identity(provider, email)
            .context("Selected account is unavailable.")?;
        self.wake.pause();
        let settings = self.settings.get();
        let provider_language = if self.device.language == "system" {
            "en"
        } else {
            &self.device.language
        };
        let notes = self.plugins.read().await.prompts();
        let commands =
            lilo_core::commands::manifest::prompt_line(self.router.registry(), &notes, true);
        let language = if self.device.language == "auto" || self.device.language == "system" {
            resolved_language.as_deref().unwrap_or("en-US")
        } else {
            &self.device.language
        };
        let language_name = match language
            .split('-')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "pt" => "Brazilian Portuguese",
            "it" => "Italian",
            "en" => "English",
            _ => language,
        };
        let surface_facts = "LILO runs on this Linux device and is managed from the phone's browser page. The phone page manages the provider account and settings. Only daemon-compatible installed plugins can run here.";
        let prompt = lilo_core::persona::build_opening_prompt(
            None,
            &self.device.language,
            language,
            language_name,
            language_name,
            &commands,
            surface_facts,
            "",
        )?;
        let opening = [
            prompt.persona.as_str(),
            prompt.manifest.as_str(),
            prompt.recap.as_str(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let status = self
            .voice
            .as_mut()
            .context("Voice is unavailable.")?
            .start(
                &account,
                &settings.default_voice,
                &settings.voice_mode,
                provider_language,
                &opening,
                &prompt.directive,
            )
            .await?;
        if status.state == VoiceState::Connected {
            self.wake.voice_started();
        }
        self.voice_turns.clear();
        self.voice_seen.clear();
        if let Some(id) = status.session_id.as_ref() {
            self.conversation_id = id.clone();
        }
        self.publish_voice_state().await;
        Ok(serde_json::to_value(status)?)
    }

    pub async fn poll_voice(&mut self) {
        self.deliver_interaction_requests().await;
        let previous = self.voice.as_ref().map(|voice| voice.status().state);
        let Some(voice) = self.voice.as_mut() else {
            return;
        };
        let events = match voice.poll().await {
            Ok(events) => events,
            Err(_) => Vec::new(),
        };
        if previous != self.voice.as_ref().map(|voice| voice.status().state) {
            if self
                .voice
                .as_ref()
                .is_some_and(|voice| voice.status().state == VoiceState::Connected)
            {
                self.wake.voice_started();
            }
            self.publish_voice_state().await;
        }
        for event in events {
            let id = event
                .turn_id
                .clone()
                .unwrap_or_else(|| format!("voice-{}", event.sequence));
            let first_seen_at = if let Some((_, _, at)) = self
                .voice_seen
                .iter()
                .find(|(speaker, seen, _)| *speaker == event.speaker && seen == &id)
            {
                *at
            } else {
                let at = now_ms();
                self.voice_seen.push_back((event.speaker, id.clone(), at));
                if self.voice_seen.len() > 128 {
                    self.voice_seen.pop_front();
                }
                at
            };
            if !event.final_ {
                // The shared router settles growing song queries and fires controls
                // immediately, even when a provider never finalizes its caption.
                if event.speaker == VoiceSpeaker::User {
                    self.route_caption(&event.text, &id, false).await;
                }
                continue;
            }
            if !remember_voice_turn(&mut self.voice_turns, event.speaker, &id) {
                continue;
            }
            match event.speaker {
                VoiceSpeaker::User => {
                    let routed = self.route(&event.text, &id).await;
                    log::info("Daemon voice received a final user caption.");
                    log::info(format!(
                        "Daemon voice routing produced {} outcomes.",
                        routed.len()
                    ));
                    for outcome in routed {
                        log::info(format!(
                            "Daemon voice route result: command={} tool={} success={}",
                            outcome.command,
                            outcome.tool.as_deref().unwrap_or("none"),
                            outcome.error.is_none()
                        ));
                    }
                }
                VoiceSpeaker::Assistant => {
                    plugins::bus::dispatch(&self.bus, &self.plugins, plugins::Event {
                        topic: "conversation.turn".into(), source: "host".into(),
                        payload: serde_json::json!({"sessionId":self.conversation_id,"at":now_ms(),"firstSeenAt":first_seen_at,
                            "turn":{"id":id,"speaker":"assistant","text":event.text,"final":true}}),
                    }).await;
                }
            }
        }
    }

    pub async fn stop_voice(&mut self) -> anyhow::Result<serde_json::Value> {
        let pending = self
            .voice
            .as_ref()
            .and_then(|voice| voice.status().events.last())
            .filter(|event| event.speaker == VoiceSpeaker::Assistant && !event.final_)
            .cloned();
        let status = self
            .voice
            .as_mut()
            .context("Voice is unavailable.")?
            .stop()
            .await?;
        if let Some(event) = pending {
            let id = event
                .turn_id
                .unwrap_or_else(|| format!("voice-{}", event.sequence));
            if !self
                .voice_turns
                .iter()
                .any(|(speaker, seen_id)| *speaker == VoiceSpeaker::Assistant && seen_id == &id)
            {
                remember_voice_turn(&mut self.voice_turns, VoiceSpeaker::Assistant, &id);
                let first_seen_at = self
                    .voice_seen
                    .iter()
                    .find(|(speaker, seen, _)| *speaker == VoiceSpeaker::Assistant && seen == &id)
                    .map(|(_, _, at)| *at)
                    .unwrap_or_else(now_ms);
                plugins::bus::dispatch(&self.bus, &self.plugins, plugins::Event { topic: "conversation.turn".into(), source: "host".into(),
                    payload: serde_json::json!({"sessionId":self.conversation_id,"at":now_ms(),"firstSeenAt":first_seen_at,
                        "turn":{"id":id,"speaker":"assistant","text":event.text,"final":true}}),
                }).await;
            }
        }
        self.publish_voice_state().await;
        plugins::bus::dispatch(
            &self.bus,
            &self.plugins,
            plugins::Event {
                topic: "conversation.ended".into(),
                source: "host".into(),
                payload: serde_json::json!({"sessionId":self.conversation_id,"at":now_ms()}),
            },
        )
        .await;
        self.wake.voice_stopped();
        self.voice_turns.clear();
        self.voice_seen.clear();
        Ok(serde_json::to_value(status)?)
    }

    pub(super) async fn publish_voice_state(&self) {
        let Some(voice) = self.voice.as_ref() else {
            return;
        };
        let status = voice.status();
        plugins::bus::dispatch(
            &self.bus,
            &self.plugins,
            plugins::Event {
                topic: "session.changed".into(),
                source: "host".into(),
                payload: session_context_payload(status),
            },
        )
        .await;
    }

    async fn deliver_interaction_requests(&mut self) {
        loop {
            let event = match self.interaction_requests.try_recv() {
                Ok(event) => event,
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
                | Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
            };
            let context = self.bus.context();
            let connected = self.voice.as_ref().is_some_and(|voice| {
                voice.status().state == VoiceState::Connected
                    && voice.status().session_id.as_deref() == context.session_id.as_deref()
                    && context.provider.as_ref().is_some_and(|protocol| {
                        protocol.inbound.user_text && protocol.outbound.text
                    })
            });
            let voice = self.voice.as_mut();
            let acknowledgement = crate::interactions::deliver(
                &event,
                now_ms(),
                context.session_id.as_deref(),
                connected,
                |hidden| async move {
                    let Some(voice) = voice else {
                        anyhow::bail!("Voice is unavailable.");
                    };
                    voice.context(&hidden).await.map(|_| ())
                },
            )
            .await;
            if let Some(event) = acknowledgement {
                plugins::bus::dispatch(&self.bus, &self.plugins, event).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::BrokerClient;
    use crate::voice::VoiceSession;
    use lilo_core::accounts::Account;
    use serde_json::Value;
    use std::thread;

    #[test]
    fn session_context_does_not_claim_question_delivery_without_a_live_session() {
        let disconnected = session_context_payload(&VoiceStatus::default());
        assert_eq!(disconnected["state"], "disconnected");
        assert!(disconnected["sessionId"].is_null());
        assert!(disconnected["provider"].is_null());

        let connected_without_id = session_context_payload(&VoiceStatus {
            state: VoiceState::Connected,
            ..VoiceStatus::default()
        });
        assert_eq!(connected_without_id["state"], "disconnected");
        assert!(connected_without_id["provider"].is_null());
    }

    #[test]
    fn connected_session_advertises_only_the_text_voice_path() {
        let context = session_context_payload(&VoiceStatus {
            state: VoiceState::Connected,
            session_id: Some("voice-1".into()),
            ..VoiceStatus::default()
        });
        assert_eq!(context["state"], "connected");
        assert_eq!(context["sessionId"], "voice-1");
        assert_eq!(context["provider"]["inbound"]["userText"], true);
        assert_eq!(context["provider"]["outbound"]["text"], true);
        assert_eq!(context["provider"]["outbound"]["toolResult"], false);
        assert_eq!(context["provider"]["outbound"]["image"], false);
    }

    #[test]
    fn identical_turn_ids_from_different_speakers_are_both_kept() {
        let mut turns = std::collections::VecDeque::new();
        assert!(remember_voice_turn(
            &mut turns,
            VoiceSpeaker::User,
            "shared-id"
        ));
        assert!(remember_voice_turn(
            &mut turns,
            VoiceSpeaker::Assistant,
            "shared-id"
        ));
        assert!(!remember_voice_turn(
            &mut turns,
            VoiceSpeaker::User,
            "shared-id"
        ));
        assert!(!remember_voice_turn(
            &mut turns,
            VoiceSpeaker::Assistant,
            "shared-id"
        ));
        assert_eq!(turns.len(), 2);
    }

    #[tokio::test]
    async fn plugin_question_is_submitted_as_hidden_text_to_the_private_broker() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let data_dir =
            std::env::temp_dir().join(format!("lilo-question-broker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let token_path = data_dir.join("token");
        let token = "b".repeat(64);
        std::fs::write(&token_path, &token).unwrap();
        let broker = BrokerClient::connect(&format!("http://{address}"), &token_path).unwrap();
        let worker = thread::spawn(move || {
            for index in 0..2 {
                let mut request = server.recv().unwrap();
                assert_eq!(request.url(), "/voice");
                assert_eq!(
                    request
                        .headers()
                        .iter()
                        .find(|header| header
                            .field
                            .as_str()
                            .to_string()
                            .eq_ignore_ascii_case("X-Lilo-Browser-Token"))
                        .unwrap()
                        .value
                        .as_str(),
                    token
                );
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let body: Value = serde_json::from_str(&body).unwrap();
                if index == 0 {
                    assert_eq!(body["action"], "start");
                } else {
                    assert_eq!(body["action"], "text");
                    assert_eq!(body["hidden"], true);
                    assert!(body["text"].as_str().unwrap().contains("How many minutes?"));
                }
                let status = serde_json::json!({
                    "state":"connected","muted":false,"sessionId":"voice-3",
                    "providerId":"chatgpt-web","events":[]
                });
                request
                    .respond(tiny_http::Response::from_string(status.to_string()))
                    .unwrap();
            }
        });

        let mut voice = VoiceSession::new(broker, vec!["chatgpt-web".into()]);
        let account = Account::chatgpt("fixture@example.invalid", "Fixture", "private-token");
        voice
            .start(
                &account,
                "cove",
                "wingman",
                "en-US",
                "instructions",
                "language instruction",
            )
            .await
            .unwrap();
        let event = lilo_core::plugins::Event {
            topic: "interaction.requested".into(),
            source: "host".into(),
            payload: serde_json::json!({
                "id":"question-1","deliveryId":"delivery-2","sessionId":"voice-3",
                "prompt":"How many minutes?","expiresAt":u64::MAX
            }),
        };
        let ack = crate::interactions::deliver(
            &event,
            now_ms(),
            Some("voice-3"),
            true,
            |hidden| async move { voice.context(&hidden).await.map(|_| ()) },
        )
        .await
        .unwrap();
        assert_eq!(ack.payload["status"], "submitted");
        assert_eq!(ack.payload["deliveryId"], "delivery-2");
        worker.join().unwrap();
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
