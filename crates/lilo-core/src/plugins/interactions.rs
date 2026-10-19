//! Bounded, provider-independent questions with explicit confirmed user answers.

use super::session::{SessionContext, SessionState};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

pub(crate) const MAX_OPTIONS_BYTES: usize = 32 * 1024;
pub(crate) const MAX_HISTORY: usize = 32;
const MAX_TURNS: usize = 128;

fn failure(message: &str) -> AppError {
    AppError::other(message)
}
fn normalized(text: &str) -> String {
    text.trim()
        .trim_end_matches(['.', '!', '?'])
        .trim()
        .to_lowercase()
}
fn default_timeout() -> u64 {
    30_000
}
fn default_retries() -> u8 {
    1
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ask {
    question: String,
    answer: AnswerSpec,
    confirmation: Confirmation,
    #[serde(default)]
    cancel: Vec<String>,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_retries")]
    retries: u8,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    question: String,
    accept: Vec<String>,
    reject: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    label: String,
    value: Value,
    matches: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum AnswerSpec {
    Choice {
        choices: Vec<Choice>,
    },
    Number {
        min: f64,
        max: f64,
        #[serde(default)]
        prefixes: Vec<String>,
        #[serde(default)]
        suffixes: Vec<String>,
    },
    Text {
        prefix: String,
        #[serde(rename = "maxLength")]
        max_length: usize,
    },
}
#[derive(Clone)]
struct Candidate {
    label: String,
    value: Value,
}
impl AnswerSpec {
    fn validate(&self) -> bool {
        match self {
            Self::Choice { choices } => {
                let mut matches = HashSet::new();
                !choices.is_empty()
                    && choices.len() <= 20
                    && choices.iter().all(|choice| {
                        bounded(&choice.label, 120)
                            && aliases(&choice.matches, true)
                            && (choice.value.is_string()
                                || choice.value.is_number()
                                || choice.value.is_boolean())
                            && serde_json::to_vec(&choice.value)
                                .is_ok_and(|value| value.len() <= 512)
                            && choice
                                .matches
                                .iter()
                                .all(|pattern| matches.insert(normalized(pattern)))
                    })
            }
            Self::Number {
                min,
                max,
                prefixes,
                suffixes,
            } => {
                min.is_finite()
                    && max.is_finite()
                    && min <= max
                    && min.abs() <= 1_000_000_000.0
                    && max.abs() <= 1_000_000_000.0
                    && aliases(prefixes, false)
                    && aliases(suffixes, false)
            }
            Self::Text { prefix, max_length } => {
                bounded(prefix, 80) && (1..=600).contains(max_length)
            }
        }
    }
    fn parse(&self, text: &str) -> Option<Candidate> {
        let text = normalized(text);
        match self {
            Self::Choice { choices } => choices
                .iter()
                .find(|choice| {
                    choice
                        .matches
                        .iter()
                        .any(|pattern| normalized(pattern) == text)
                })
                .map(|choice| Candidate {
                    label: choice.label.clone(),
                    value: choice.value.clone(),
                }),
            Self::Number {
                min,
                max,
                prefixes,
                suffixes,
            } => {
                let mut number = text.as_str();
                if !prefixes.is_empty() {
                    number = prefixes
                        .iter()
                        .find_map(|prefix| number.strip_prefix(&(normalized(prefix) + " ")))
                        .unwrap_or(number);
                }
                if let Some(stripped) = suffixes
                    .iter()
                    .find_map(|suffix| number.strip_suffix(&(" ".to_owned() + &normalized(suffix))))
                {
                    number = stripped;
                }
                let number = number.trim().replace(',', ".").parse::<f64>().ok()?;
                if !number.is_finite() || number < *min || number > *max {
                    return None;
                }
                let value = if number.fract() == 0.0 {
                    json!(number as i64)
                } else {
                    json!(number)
                };
                Some(Candidate {
                    label: number.to_string(),
                    value,
                })
            }
            Self::Text { prefix, max_length } => {
                let value = text.strip_prefix(&(normalized(prefix) + " "))?.trim();
                if !bounded(value, *max_length) {
                    return None;
                }
                Some(Candidate {
                    label: value.into(),
                    value: json!(value),
                })
            }
        }
    }
}
fn bounded(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max
}
fn aliases(values: &[String], required: bool) -> bool {
    (!required || !values.is_empty())
        && values.len() <= 16
        && values.iter().all(|value| bounded(&normalized(value), 120))
}
impl Ask {
    fn parse(value: Value) -> Result<Self> {
        if serde_json::to_vec(&value)?.len() > MAX_OPTIONS_BYTES {
            return Err(failure("Interaction options exceed byte limit."));
        }
        let ask: Self =
            serde_json::from_value(value).map_err(|_| failure("Invalid interaction options."))?;
        let mut confirmation_aliases = HashSet::new();
        if !bounded(&ask.question, 1000)
            || !ask.answer.validate()
            || !bounded(&ask.confirmation.question, 1000)
            || ask.confirmation.question.matches("{answer}").count() != 1
            || !aliases(&ask.confirmation.accept, true)
            || !aliases(&ask.confirmation.reject, true)
            || !aliases(&ask.cancel, false)
            || !(5000..=120_000).contains(&ask.timeout_ms)
            || ask.retries > 2
            || !ask
                .confirmation
                .accept
                .iter()
                .chain(&ask.confirmation.reject)
                .chain(&ask.cancel)
                .all(|alias| confirmation_aliases.insert(normalized(alias)))
        {
            return Err(failure(
                "Interaction prompt, answer shape, aliases or limits are invalid.",
            ));
        }
        Ok(ask)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    plugin_id: String,
    session_id: Option<String>,
    status: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}
struct Pending {
    record: Record,
    ask: Ask,
    delivery_id: String,
    deadline: u64,
    submitted_at: Option<u64>,
    candidate: Option<Candidate>,
    retries: u8,
    seen: VecDeque<String>,
}
pub(crate) struct Publication {
    pub topic: &'static str,
    pub payload: Value,
}
#[derive(Default)]
pub(crate) struct Manager {
    pending: Option<Pending>,
    history: VecDeque<Record>,
    events: Vec<Publication>,
}
impl Manager {
    pub(crate) fn take_events(&mut self) -> Vec<Publication> {
        std::mem::take(&mut self.events)
    }
    fn emit(&mut self, topic: &'static str, payload: Value) {
        if self.events.len() >= 64 {
            self.events.remove(0);
        }
        self.events.push(Publication { topic, payload });
    }
    fn changed(&mut self, record: &Record) {
        self.emit("interaction.changed", json!(record));
    }
    fn queue(&mut self, pending: &mut Pending, now: u64) {
        pending.delivery_id = uuid::Uuid::new_v4().to_string();
        pending.submitted_at = None;
        pending.deadline = now.saturating_add(pending.ask.timeout_ms);
        pending.record.status = "waitingDelivery".into();
        let prompt = pending
            .candidate
            .as_ref()
            .map(|candidate| {
                pending
                    .ask
                    .confirmation
                    .question
                    .replace("{answer}", &candidate.label)
            })
            .unwrap_or_else(|| pending.ask.question.clone());
        self.changed(&pending.record);
        self.emit("interaction.requested", json!({"id":pending.record.id,"pluginId":pending.record.plugin_id,
            "sessionId":pending.record.session_id,"deliveryId":pending.delivery_id,"prompt":prompt,"expiresAt":pending.deadline}));
    }
    fn finish(&mut self, mut pending: Pending, status: &str, reason: Option<&str>) -> Value {
        pending.record.status = status.into();
        pending.record.reason = reason.map(str::to_owned);
        pending.record.candidate = None;
        if status == "confirmed" {
            pending.record.answer = pending.candidate.map(|candidate| candidate.value);
        }
        self.changed(&pending.record);
        let value = json!(pending.record);
        if self.history.len() >= MAX_HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(pending.record);
        value
    }
    pub(crate) fn request(
        &mut self,
        owner: &str,
        operation: &str,
        args: Value,
        context: &SessionContext,
        now: u64,
    ) -> Result<Value> {
        self.tick(context, now);
        match operation {
            "list" => Ok(
                json!({"active":self.pending.as_ref().filter(|pending| pending.record.plugin_id == owner).map(|pending| &pending.record),
                "history":self.history.iter().filter(|record| record.plugin_id == owner).collect::<Vec<_>>()}),
            ),
            "cancel" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("Interaction cancellation requires id."))?;
                if !self.pending.as_ref().is_some_and(|pending| {
                    pending.record.id == id && pending.record.plugin_id == owner
                }) {
                    return Err(failure("No owned pending interaction matches this id."));
                }
                let pending = self
                    .pending
                    .take()
                    .ok_or_else(|| failure("Interaction is unavailable."))?;
                Ok(self.finish(pending, "canceled", Some("plugin-canceled")))
            }
            "ask" => {
                let ask = Ask::parse(args)?;
                if self.pending.is_some() {
                    return Err(failure(
                        "Another voice question is pending; wait or cancel your own question.",
                    ));
                }
                let mut pending = Pending {
                    record: Record {
                        id: uuid::Uuid::new_v4().to_string(),
                        plugin_id: owner.into(),
                        session_id: context.session_id.clone(),
                        status: "waitingDelivery".into(),
                        phase: "answer".into(),
                        candidate: None,
                        answer: None,
                        reason: None,
                    },
                    ask,
                    delivery_id: String::new(),
                    deadline: 0,
                    submitted_at: None,
                    candidate: None,
                    retries: 0,
                    seen: VecDeque::new(),
                };
                if !supported(context) {
                    return Ok(self.finish(
                        pending,
                        "unsupported",
                        Some("No compatible live question/answer channel."),
                    ));
                }
                self.queue(&mut pending, now);
                let result = json!(pending.record);
                self.pending = Some(pending);
                Ok(result)
            }
            _ => Err(failure("Unknown interaction operation.")),
        }
    }
    pub(crate) fn cancel_owner(&mut self, owner: &str) {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.record.plugin_id == owner)
        {
            if let Some(pending) = self.pending.take() {
                self.finish(pending, "canceled", Some("plugin-stopped"));
            }
        }
    }
    pub(crate) fn interrupt(&mut self, reason: &str) {
        if let Some(pending) = self.pending.take() {
            self.finish(pending, "canceled", Some(reason));
        }
    }
    pub(crate) fn tick(&mut self, context: &SessionContext, now: u64) {
        let Some(mut pending) = self.pending.take() else {
            return;
        };
        if !supported(context) || pending.record.session_id != context.session_id {
            self.finish(pending, "canceled", Some("session-ended-or-unavailable"));
        } else if now >= pending.deadline {
            if pending.retries < pending.ask.retries {
                pending.retries += 1;
                self.queue(&mut pending, now);
                self.pending = Some(pending);
            } else {
                self.finish(
                    pending,
                    "timedOut",
                    Some("No confirmed answer before the deadline."),
                );
            }
        } else {
            self.pending = Some(pending);
        }
    }
    pub(crate) fn ingest(
        &mut self,
        topic: &str,
        payload: &Value,
        context: &SessionContext,
        now: u64,
    ) {
        self.tick(context, now);
        let Some(mut pending) = self.pending.take() else {
            return;
        };
        if topic == "conversation.ended"
            && payload.get("sessionId") == Some(&json!(pending.record.session_id))
        {
            self.finish(pending, "canceled", Some("session-ended"));
            return;
        }
        if topic == "interaction.delivery" {
            if pending.record.status == "waitingDelivery"
                && payload.get("id").and_then(Value::as_str) == Some(&pending.record.id)
                && payload.get("deliveryId").and_then(Value::as_str) == Some(&pending.delivery_id)
                && payload.get("sessionId").and_then(Value::as_str)
                    == pending.record.session_id.as_deref()
            {
                match payload.get("status").and_then(Value::as_str) {
                    Some("submitted") => {
                        pending.submitted_at = Some(now);
                        pending.deadline = now.saturating_add(pending.ask.timeout_ms);
                        pending.record.status = if pending.candidate.is_some() {
                            "awaitingConfirmation"
                        } else {
                            "awaitingAnswer"
                        }
                        .into();
                        self.changed(&pending.record);
                    }
                    Some("unsupported") => {
                        self.finish(
                            pending,
                            "unsupported",
                            Some("Voice adapter cannot submit the question."),
                        );
                        return;
                    }
                    Some("failed") => {
                        self.finish(pending, "failed", Some("Question submission failed."));
                        return;
                    }
                    _ => {}
                }
            }
        } else if topic == "conversation.turn" {
            let turn = &payload["turn"];
            let fresh = payload
                .get("firstSeenAt")
                .and_then(Value::as_u64)
                .zip(pending.submitted_at)
                .is_some_and(|(first, submitted)| first > submitted && first <= now);
            let id = turn.get("id").and_then(Value::as_str).unwrap_or("");
            let text = turn.get("text").and_then(Value::as_str).unwrap_or("");
            if payload.get("sessionId").and_then(Value::as_str)
                == pending.record.session_id.as_deref()
                && fresh
                && turn.get("speaker").and_then(Value::as_str) == Some("user")
                && turn.get("final").and_then(Value::as_bool) == Some(true)
                && bounded(id, 128)
                && bounded(text, 2000)
                && !text.starts_with("[LILO]")
                && !pending.seen.iter().any(|seen| seen == id)
            {
                if pending.seen.len() >= MAX_TURNS {
                    pending.seen.pop_front();
                }
                pending.seen.push_back(id.into());
                let answer = normalized(text);
                if pending
                    .ask
                    .cancel
                    .iter()
                    .any(|alias| normalized(alias) == answer)
                {
                    self.finish(pending, "canceled", Some("user-canceled"));
                    return;
                }
                if pending.candidate.is_some() {
                    if pending
                        .ask
                        .confirmation
                        .accept
                        .iter()
                        .any(|alias| normalized(alias) == answer)
                    {
                        self.finish(pending, "confirmed", None);
                        return;
                    }
                    if pending
                        .ask
                        .confirmation
                        .reject
                        .iter()
                        .any(|alias| normalized(alias) == answer)
                    {
                        self.finish(
                            pending,
                            "declined",
                            Some("User rejected the candidate answer."),
                        );
                        return;
                    }
                } else if let Some(candidate) = pending.ask.answer.parse(text) {
                    pending.record.candidate = Some(candidate.value.clone());
                    pending.record.phase = "confirmation".into();
                    pending.candidate = Some(candidate);
                    self.queue(&mut pending, now);
                }
            }
        }
        self.pending = Some(pending);
    }
}
fn supported(context: &SessionContext) -> bool {
    context.state == SessionState::Connected
        && context.session_id.is_some()
        && context
            .provider
            .as_ref()
            .is_some_and(|provider| provider.inbound.user_text && provider.outbound.text)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> super::super::session::SessionContext {
        super::super::session::SessionContext::parse(json!({"sessionId":"voice-1","state":"connected",
            "provider":{"inbound":{"userText":true,"assistantText":true,"nativeToolCalls":false,"images":false},
            "outbound":{"text":true,"stopSpeaking":true,"systemPrompt":true,"toolResult":false,"image":false}}})).unwrap()
    }
    fn options() -> Value {
        json!({"question":"How many minutes?","answer":{"kind":"number","min":5,"max":60,"suffixes":["minutes"]},
        "confirmation":{"question":"You said {answer} minutes. Confirm?","accept":["yes"],"reject":["no"]},
        "cancel":["cancel"],"timeoutMs":5000,"retries":1})
    }
    fn acknowledge(
        manager: &mut Manager,
        context: &super::super::session::SessionContext,
        now: u64,
    ) {
        let requested = manager
            .take_events()
            .into_iter()
            .find(|event| event.topic == "interaction.requested")
            .unwrap();
        manager.ingest(
            "interaction.delivery",
            &json!({"id":requested.payload["id"],"deliveryId":requested.payload["deliveryId"],
            "sessionId":"voice-1","status":"submitted"}),
            context,
            now,
        );
    }
    fn caption(
        manager: &mut Manager,
        context: &super::super::session::SessionContext,
        id: &str,
        speaker: &str,
        text: &str,
        first: u64,
        now: u64,
    ) {
        manager.ingest(
            "conversation.turn",
            &json!({"sessionId":"voice-1","firstSeenAt":first,
            "turn":{"id":id,"speaker":speaker,"text":text,"final":true}}),
            context,
            now,
        );
    }

    #[test]
    fn test_question_requires_fresh_user_answer_and_a_separate_confirmation() {
        let context = session();
        let mut manager = Manager::default();
        let created = manager
            .request("plugin-a", "ask", options(), &context, 100)
            .unwrap();
        assert_eq!(created["status"], "waitingDelivery");
        acknowledge(&mut manager, &context, 110);
        caption(
            &mut manager,
            &context,
            "assistant",
            "assistant",
            "15 minutes",
            120,
            120,
        );
        caption(&mut manager, &context, "old", "user", "15 minutes", 90, 130);
        caption(
            &mut manager,
            &context,
            "unrelated",
            "user",
            "What is the weather?",
            135,
            135,
        );
        assert_eq!(
            manager
                .request("plugin-a", "list", json!({}), &context, 140)
                .unwrap()["active"]["status"],
            "awaitingAnswer"
        );
        caption(
            &mut manager,
            &context,
            "answer",
            "user",
            "15 minutes",
            150,
            150,
        );
        acknowledge(&mut manager, &context, 160);
        caption(&mut manager, &context, "answer", "user", "yes", 150, 170);
        assert_eq!(
            manager
                .request("plugin-a", "list", json!({}), &context, 170)
                .unwrap()["active"]["status"],
            "awaitingConfirmation"
        );
        caption(&mut manager, &context, "confirm", "user", "yes", 180, 180);
        let own = manager
            .request("plugin-a", "list", json!({}), &context, 190)
            .unwrap();
        assert_eq!(own["history"][0]["status"], "confirmed");
        assert_eq!(own["history"][0]["answer"], 15);
        assert!(manager
            .request("plugin-b", "list", json!({}), &context, 190)
            .unwrap()["history"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_expected_answer_shapes_are_bounded_and_authored_without_language_logic() {
        let number: AnswerSpec = serde_json::from_value(
            json!({"kind":"number","min":5,"max":60,"prefixes":["tenho"],"suffixes":["minutos"]}),
        )
        .unwrap();
        assert_eq!(number.parse("tenho 15 minutos").unwrap().value, json!(15));
        assert_eq!(number.parse("15 minutos").unwrap().value, json!(15));
        assert!(number.parse("Tenho dois trabalhos").is_none());
        let choice: AnswerSpec = serde_json::from_value(json!({"kind":"choice","choices":[{"label":"Conversation","value":"conversation","matches":["conversa","conversation"]}]})).unwrap();
        assert!(choice.validate());
        assert_eq!(
            choice.parse("Conversa!").unwrap().value,
            json!("conversation")
        );
        let text: AnswerSpec =
            serde_json::from_value(json!({"kind":"text","prefix":"my goal is","maxLength":30}))
                .unwrap();
        assert_eq!(
            text.parse("My goal is order lunch").unwrap().value,
            json!("order lunch")
        );
        assert!(text.parse("order lunch").is_none());
        assert!(text
            .parse(&format!("my goal is {}", "x".repeat(31)))
            .is_none());
    }

    #[test]
    fn test_another_host_confirmation_interrupts_the_question_instead_of_sharing_yes() {
        let context = session();
        let mut manager = Manager::default();
        manager
            .request("owner", "ask", options(), &context, 100)
            .unwrap();
        acknowledge(&mut manager, &context, 110);
        caption(&mut manager, &context, "answer", "user", "15", 120, 120);
        acknowledge(&mut manager, &context, 130);
        manager.interrupt("command-confirmation");
        caption(
            &mut manager,
            &context,
            "other-approval",
            "user",
            "yes",
            140,
            140,
        );
        let state = manager
            .request("owner", "list", json!({}), &context, 150)
            .unwrap();
        assert_eq!(state["history"][0]["status"], "canceled");
        assert!(state["history"][0].get("answer").is_none());
    }

    #[test]
    fn test_question_limits_retry_timeout_cancellation_and_provider_absence() {
        let context = session();
        let mut manager = Manager::default();
        let created = manager
            .request("a", "ask", options(), &context, 100)
            .unwrap();
        assert!(manager
            .request("b", "ask", options(), &context, 101)
            .is_err());
        assert!(manager
            .request("b", "cancel", json!({"id":created["id"]}), &context, 101)
            .is_err());
        manager.tick(&context, 5100);
        assert_eq!(
            manager
                .take_events()
                .iter()
                .filter(|event| event.topic == "interaction.requested")
                .count(),
            2
        );
        manager.tick(&context, 10100);
        assert_eq!(
            manager
                .request("a", "list", json!({}), &context, 10101)
                .unwrap()["history"][0]["status"],
            "timedOut"
        );
        let created = manager
            .request("a", "ask", options(), &context, 11000)
            .unwrap();
        manager
            .request("a", "cancel", json!({"id":created["id"]}), &context, 11001)
            .unwrap();
        assert_eq!(
            manager
                .request("a", "list", json!({}), &context, 11002)
                .unwrap()["history"][1]["status"],
            "canceled"
        );
        let unsupported = manager
            .request(
                "a",
                "ask",
                options(),
                &super::super::session::SessionContext::default(),
                12000,
            )
            .unwrap();
        assert_eq!(unsupported["status"], "unsupported");
        let mut oversized = options();
        oversized["question"] = json!("x".repeat(1001));
        assert!(manager
            .request("a", "ask", oversized, &context, 13000)
            .is_err());
    }
}
