//! Delivery bridge for plugin-owned questions to the active daemon voice.

use anyhow::Result;
use lilo_core::plugins::Event;
use serde_json::json;
use std::future::Future;

struct Question {
    id: String,
    delivery_id: String,
    session_id: String,
    prompt: String,
    expires_at: u64,
}

fn safe_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn parse(event: &Event, now: u64) -> Option<Question> {
    if event.source != "host" || event.topic != "interaction.requested" {
        return None;
    }
    let payload = &event.payload;
    let id = payload.get("id")?.as_str()?;
    let delivery_id = payload.get("deliveryId")?.as_str()?;
    let session_id = payload.get("sessionId")?.as_str()?;
    let prompt = payload.get("prompt")?.as_str()?;
    let expires_at = payload.get("expiresAt")?.as_u64()?;
    if !safe_id(id, 128)
        || !safe_id(delivery_id, 128)
        || !safe_id(session_id, 128)
        || prompt.trim().is_empty()
        || prompt.len() > 2000
        || expires_at <= now
    {
        return None;
    }
    Some(Question {
        id: id.into(),
        delivery_id: delivery_id.into(),
        session_id: session_id.into(),
        prompt: prompt.into(),
        expires_at,
    })
}

fn acknowledgement(question: Question, status: &str) -> Event {
    Event {
        topic: "interaction.delivery".into(),
        source: "host".into(),
        payload: json!({
            "id": question.id,
            "deliveryId": question.delivery_id,
            "sessionId": question.session_id,
            "status": status,
        }),
    }
}

/// Send one live question through the voice adapter and return the matching
/// manager acknowledgement. A successful hidden text submission means the
/// adapter accepted the prompt, not that the user heard it.
pub(crate) async fn deliver<F, Fut>(
    event: &Event,
    now: u64,
    active_session: Option<&str>,
    connected: bool,
    submit: F,
) -> Option<Event>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let question = parse(event, now)?;
    if !connected || active_session != Some(question.session_id.as_str()) {
        return Some(acknowledgement(question, "unsupported"));
    }
    if question.expires_at <= now {
        return None;
    }
    let hidden = format!(
        "[LILO] Ask the user this question in its language. Do not answer it yourself or invent a user reply: {}",
        question.prompt
    );
    let status = if submit(hidden).await.is_ok() {
        "submitted"
    } else {
        "failed"
    };
    Some(acknowledgement(question, status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn request() -> Event {
        Event {
            topic: "interaction.requested".into(),
            source: "host".into(),
            payload: json!({
                "id":"question-1",
                "deliveryId":"delivery-2",
                "sessionId":"voice-3",
                "prompt":"How many minutes?",
                "expiresAt":2000
            }),
        }
    }

    #[tokio::test]
    async fn submits_hidden_question_and_preserves_manager_correlation() {
        let sent = RefCell::new(None);
        let ack = deliver(&request(), 1000, Some("voice-3"), true, |prompt| async {
            *sent.borrow_mut() = Some(prompt);
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(
            sent.into_inner().as_deref(),
            Some("[LILO] Ask the user this question in its language. Do not answer it yourself or invent a user reply: How many minutes?")
        );
        assert_eq!(ack.topic, "interaction.delivery");
        assert_eq!(ack.source, "host");
        assert_eq!(ack.payload["id"], "question-1");
        assert_eq!(ack.payload["deliveryId"], "delivery-2");
        assert_eq!(ack.payload["sessionId"], "voice-3");
        assert_eq!(ack.payload["status"], "submitted");
    }

    #[tokio::test]
    async fn disconnected_or_mismatched_voice_is_acknowledged_unsupported() {
        let sent = RefCell::new(false);
        let ack = deliver(
            &request(),
            1000,
            Some("another-session"),
            false,
            |_| async {
                *sent.borrow_mut() = true;
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(ack.payload["status"], "unsupported");
        assert!(!sent.into_inner());
    }

    #[tokio::test]
    async fn adapter_failure_is_acknowledged_failed() {
        let ack = deliver(&request(), 1000, Some("voice-3"), true, |_| async {
            Err(anyhow::anyhow!("private broker unavailable"))
        })
        .await
        .unwrap();
        assert_eq!(ack.payload["status"], "failed");
        assert!(!ack
            .payload
            .to_string()
            .contains("private broker unavailable"));
    }

    #[tokio::test]
    async fn invalid_or_expired_event_is_never_submitted() {
        let mut invalid = request();
        invalid.payload["sessionId"] = serde_json::Value::String("../../private".into());
        assert!(
            deliver(&invalid, 1000, Some("voice-3"), true, |_| async { Ok(()) })
                .await
                .is_none()
        );

        let mut expired = request();
        expired.payload["expiresAt"] = json!(1000);
        assert!(
            deliver(&expired, 1000, Some("voice-3"), true, |_| async { Ok(()) })
                .await
                .is_none()
        );
    }
}
