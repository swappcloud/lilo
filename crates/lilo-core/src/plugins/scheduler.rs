//! Durable jobs owned by one JavaScript plugin; calendar logic stays in JavaScript.

use super::durable::Store;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const MAX_JOBS: usize = 32;
pub(crate) const MAX_ARGS_BYTES: usize = 8192;
const MAX_TIME: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Job {
    pub id: String,
    pub tool: String,
    #[serde(default = "empty_args")]
    pub args: Value,
    pub at: u64,
    #[serde(default)]
    every_ms: Option<u64>,
    #[serde(default = "run_once")]
    missed: String,
}
fn empty_args() -> Value {
    json!({})
}
fn run_once() -> String {
    "runOnce".into()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    id: String,
    scheduled_at: u64,
    delivered_at: u64,
    status: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    jobs: Vec<Job>,
    history: Vec<Delivery>,
}
pub(crate) struct Scheduler {
    store: Store,
    state: State,
    recovered: bool,
}
#[derive(Clone)]
pub(crate) struct Fire {
    pub id: String,
    pub tool: String,
    pub args: Value,
    pub at: u64,
}

impl Scheduler {
    pub(crate) fn request(
        &mut self,
        operation: &str,
        args: Value,
        owned: &[String],
    ) -> Result<Value> {
        match operation {
            "put" => self.put(args, owned),
            "list" => Ok(self.list()),
            "cancel" => self.cancel(
                args.get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("Schedule cancellation requires id."))?,
            ),
            _ => Err(error("Unknown schedule operation.")),
        }
    }
    pub(crate) fn load(store: Store) -> Result<Self> {
        let record = store.read("queue")?;
        let state = if record.found {
            if record.schema_version != 1 {
                return Err(error("Unsupported schedule schema; data was preserved."));
            }
            serde_json::from_value::<State>(record.value)
                .map_err(|_| error("Invalid schedule data; data was preserved."))?
        } else {
            State {
                version: 1,
                jobs: Vec::new(),
                history: Vec::new(),
            }
        };
        if state.version != 1 || state.jobs.len() > MAX_JOBS || state.history.len() > MAX_JOBS {
            return Err(error(
                "Unsupported or oversized schedule data; data was preserved.",
            ));
        }
        for job in &state.jobs {
            validate(job)?;
        }
        Ok(Self {
            store,
            state,
            recovered: record.recovered,
        })
    }
    fn commit(&mut self, state: State) -> Result<()> {
        // Do not let a recovery copy resurrect canceled or claimed jobs.
        self.store
            .write("queue", serde_json::to_value(&state)?, 1, None, true)?;
        self.state = state;
        self.recovered = false;
        Ok(())
    }
    pub(crate) fn put(&mut self, value: Value, owned: &[String]) -> Result<Value> {
        let job: Job =
            serde_json::from_value(value).map_err(|_| error("Invalid schedule options."))?;
        validate(&job)?;
        if !owned.contains(&job.tool) {
            return Err(error("Scheduled tool must belong to this plugin."));
        }
        let mut next = self.state.clone();
        if let Some(existing) = next.jobs.iter_mut().find(|existing| existing.id == job.id) {
            *existing = job;
        } else {
            if next.jobs.len() >= MAX_JOBS {
                return Err(error("Schedule job limit reached."));
            }
            next.jobs.push(job);
        }
        self.commit(next)?;
        Ok(self.list())
    }
    pub(crate) fn cancel(&mut self, id: &str) -> Result<Value> {
        let mut next = self.state.clone();
        next.jobs.retain(|job| job.id != id);
        if next.jobs.len() != self.state.jobs.len() {
            self.commit(next)?;
        }
        Ok(self.list())
    }
    pub(crate) fn list(&self) -> Value {
        json!({"jobs": self.state.jobs, "history": self.state.history, "recovered": self.recovered})
    }

    pub(crate) fn due(&mut self, now: u64) -> Result<Option<Fire>> {
        let Some(index) = self
            .state
            .jobs
            .iter()
            .enumerate()
            .filter(|(_, job)| job.at <= now)
            .min_by_key(|(_, job)| job.at)
            .map(|(index, _)| index)
        else {
            return Ok(None);
        };
        let mut next = self.state.clone();
        let job = next.jobs.remove(index);
        let skip = job.missed == "skip" && now.saturating_sub(job.at) > 60_000;
        if let Some(interval) = job.every_ms {
            let steps = now.saturating_sub(job.at) / interval + 1;
            let at = steps
                .checked_mul(interval)
                .and_then(|delta| job.at.checked_add(delta))
                .filter(|at| *at <= MAX_TIME)
                .ok_or_else(|| error("Schedule recurrence exceeds the supported clock."))?;
            next.jobs.push(Job { at, ..job.clone() });
        }
        next.history.push(Delivery {
            id: job.id.clone(),
            scheduled_at: job.at,
            delivered_at: now,
            status: if skip { "skipped" } else { "claimed" }.into(),
        });
        if next.history.len() > MAX_JOBS {
            next.history.remove(0);
        }
        self.commit(next)?;
        if skip {
            Ok(None)
        } else {
            Ok(Some(Fire {
                id: job.id,
                tool: job.tool,
                args: job.args,
                at: job.at,
            }))
        }
    }
    pub(crate) fn finish(&mut self, fire: &Fire, status: &str) -> Result<()> {
        let mut next = self.state.clone();
        if let Some(delivery) = next
            .history
            .iter_mut()
            .rev()
            .find(|delivery| delivery.id == fire.id && delivery.scheduled_at == fire.at)
        {
            delivery.status = status.into();
            self.commit(next)?;
        }
        Ok(())
    }
}
fn error(message: &str) -> AppError {
    AppError::other(message)
}
fn validate(job: &Job) -> Result<()> {
    if job.id.is_empty()
        || job.id.len() > 64
        || !job
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        || job.tool.is_empty()
        || job.tool.len() > 128
        || job.at == 0
        || job.at > MAX_TIME
        || !matches!(job.missed.as_str(), "runOnce" | "skip")
    {
        return Err(error(
            "Invalid schedule id, tool, time or missed-job policy.",
        ));
    }
    if job
        .every_ms
        .is_some_and(|interval| !(60_000..=31_536_000_000).contains(&interval))
    {
        return Err(error(
            "Schedule interval must be between one minute and 365 days.",
        ));
    }
    if !job.args.is_object() || serde_json::to_vec(&job.args)?.len() > MAX_ARGS_BYTES {
        return Err(error(
            "Schedule arguments must be an object within the byte limit.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claim_survives_restart_without_replaying_an_uncertain_delivery() {
        let root = std::env::temp_dir().join(format!("lilo-claim-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone());
        let mut scheduler = Scheduler::load(store).unwrap();
        scheduler
            .put(
                json!({"id":"once","tool":"deliver","at":1000}),
                &["deliver".into()],
            )
            .unwrap();
        assert!(scheduler.due(1000).unwrap().is_some());
        drop(scheduler);
        let mut restarted = Scheduler::load(Store::new(root.clone())).unwrap();
        assert!(restarted.due(2000).unwrap().is_none());
        assert_eq!(restarted.list()["history"][0]["status"], "claimed");
        assert!(restarted
            .put(
                json!({"id":"fast","tool":"deliver","at":1000,"everyMs":1000}),
                &["deliver".into()]
            )
            .is_err());
        assert!(restarted.put(json!({"id":"large","tool":"deliver","at":1000,"args":{"text":"x".repeat(MAX_ARGS_BYTES)}}), &["deliver".into()]).is_err());
        for index in 0..MAX_JOBS {
            restarted
                .put(
                    json!({"id":format!("job{index}"),"tool":"deliver","at":3000}),
                    &["deliver".into()],
                )
                .unwrap();
        }
        assert!(restarted
            .put(
                json!({"id":"overflow","tool":"deliver","at":3000}),
                &["deliver".into()]
            )
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("lilo-schedule-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn test_scheduler_restarts_without_replay_bursts_and_cancellation_survives_recovery() {
        let root = root();
        let store = || super::super::durable::Store::new(root.clone());
        let mut scheduler = Scheduler::load(store()).unwrap();
        scheduler.put(serde_json::json!({"id":"review", "tool":"review_today", "at":1000, "everyMs":86400000}), &["review_today".into()]).unwrap();
        let mut restarted = Scheduler::load(store()).unwrap();
        let fire = restarted.due(864000000).unwrap().unwrap();
        assert_eq!(fire.id, "review");
        assert!(restarted.due(864000000).unwrap().is_none());
        restarted.finish(&fire, "completed").unwrap();
        restarted.cancel("review").unwrap();
        std::fs::write(root.join("queue.json"), "{broken").unwrap();
        let mut recovered = Scheduler::load(store()).unwrap();
        assert!(recovered.due(900000000).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn test_scheduler_rejects_unowned_tools_and_skips_missed_one_shots() {
        let root = root();
        let mut scheduler =
            Scheduler::load(super::super::durable::Store::new(root.clone())).unwrap();
        assert!(scheduler
            .put(
                serde_json::json!({"id":"bad", "tool":"other_tool", "at":1000}),
                &["review_today".into()]
            )
            .is_err());
        scheduler
            .put(
                serde_json::json!({"id":"skip", "tool":"review_today", "at":1000, "missed":"skip"}),
                &["review_today".into()],
            )
            .unwrap();
        assert!(scheduler.due(100000).unwrap().is_none());
        assert_eq!(scheduler.list()["history"][0]["status"], "skipped");
        std::fs::remove_dir_all(root).unwrap();
    }
}
