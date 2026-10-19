//! The built-in tools: time and web search.
//!
//! Both are free and keyless. They are a `ToolProvider` like any other — the
//! host no longer knows their names, it only knows the registry. Media tools
//! live with the media service, which owns their behaviour.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::plugins::{BoxFuture, PluginManifest, ToolProvider};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// The built-in provider. Holds the HTTP client `web_search` needs.
pub struct BuiltinTools {
    http: reqwest::Client,
}

impl BuiltinTools {
    pub fn new(http: reqwest::Client) -> Self {
        BuiltinTools { http }
    }

    /// Tools this provider owns.
    pub fn describe() -> Vec<ToolDescriptor> {
        vec![
        ToolDescriptor {
            name: "get_current_time".to_string(),
            description:
                "Get the current date and time. Optionally specify an IANA timezone (e.g. `Europe/Paris`).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "timezone": {
                        "type": "string",
                        "description": "IANA timezone name. Defaults to the system timezone."
                    }
                },
                "required": []
            }),
        },
        ToolDescriptor {
            name: "web_search".to_string(),
            description:
                "Search the web for a short factual answer. Uses DuckDuckGo; no API key required."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The search query." },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results (1-10). Defaults to 5.",
                        "minimum": 1,
                        "maximum": 10
                    }
                },
                "required": ["query"]
            }),
        },
        ToolDescriptor {
            name: "lilo_mood".to_string(),
            description:
                "Show an expression on LILO's face: happy, sad, angry, surprised, or neutral to go back to normal."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "mood": {
                        "type": "string",
                        "description": "happy, sad, angry, surprised, or neutral",
                        "enum": ["happy", "sad", "angry", "surprised", "neutral"]
                    }
                },
                "required": ["mood"]
            }),
        },
        ]
    }
}

/// Identity and declared permissions. The media service does the same with its
/// own manifest; a marketplace plugin will declare far more than this.
fn manifest() -> PluginManifest {
    PluginManifest::new("core.tools", "Built-in tools", env!("CARGO_PKG_VERSION"))
        .with_hosts(&["desktop", "daemon"])
        .with_capabilities(&["http:duckduckgo.com", "time:local"])
}

/// Built once: `manifest()` hands out a reference, so it must outlive the call.
static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();

impl ToolProvider for BuiltinTools {
    fn manifest(&self) -> &PluginManifest {
        MANIFEST.get_or_init(manifest)
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        Self::describe()
    }

    fn handles(&self, tool: &str) -> bool {
        matches!(tool, "get_current_time" | "web_search" | "lilo_mood")
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            match tool {
                "get_current_time" => {
                    let timezone = args.get("timezone").and_then(|v| v.as_str());
                    Ok(serde_json::to_value(current_time(timezone)?)?)
                }
                "lilo_mood" => crate::mood::run(args),
                "web_search" => {
                    let query = args
                        .get("query")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| AppError::other("web_search requires a `query`"))?;
                    let max = args
                        .get("max_results")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32);
                    let results = web_search(&self.http, query, max).await?;
                    Ok(serde_json::to_value(results)?)
                }
                other => Err(AppError::other(format!(
                    "built-in tools cannot run {other}"
                ))),
            }
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeResult {
    pub iso: String,
    pub formatted: String,
    pub timezone: String,
    pub offset_minutes: i32,
    pub unix: i64,
    pub weekday: String,
}

/// Resolve an IANA timezone name tolerantly: exact match first, then a
/// case-insensitive lookup (so `europe/rome` → `Europe/Rome`).
fn parse_timezone(name: &str) -> Result<chrono_tz::Tz> {
    let cleaned = name.trim().replace(' ', "_");
    if let Ok(tz) = cleaned.parse::<chrono_tz::Tz>() {
        return Ok(tz);
    }
    let lower = cleaned.to_ascii_lowercase();
    if let Some(tz) = chrono_tz::TZ_VARIANTS
        .iter()
        .find(|tz| tz.name().to_ascii_lowercase() == lower)
    {
        return Ok(*tz);
    }
    Err(AppError::other(format!(
        "unknown IANA timezone: {name}. Try a name like Europe/Rome, America/New_York or UTC."
    )))
}

/// Current time in the requested IANA timezone, or the system timezone.
pub fn current_time(timezone: Option<&str>) -> Result<TimeResult> {
    use chrono::{Offset, Utc};

    let now = Utc::now();
    let requested = timezone.map(str::trim).filter(|z| !z.is_empty());

    let (iso, formatted, tz_name, offset_minutes, weekday) = match requested {
        Some(name) if !name.eq_ignore_ascii_case("local") => {
            let tz: chrono_tz::Tz = parse_timezone(name)?;
            let dt = now.with_timezone(&tz);
            (
                dt.to_rfc3339(),
                dt.format("%Y-%m-%d %H:%M:%S %Z").to_string(),
                tz.name().to_string(),
                dt.offset().fix().local_minus_utc() / 60,
                dt.format("%A").to_string(),
            )
        }
        _ => {
            let dt = now.with_timezone(&chrono::Local);
            (
                dt.to_rfc3339(),
                dt.format("%Y-%m-%d %H:%M:%S %Z").to_string(),
                iana_time_zone::get_timezone().unwrap_or_else(|_| "local".to_string()),
                dt.offset().fix().local_minus_utc() / 60,
                dt.format("%A").to_string(),
            )
        }
    };

    Ok(TimeResult {
        iso,
        formatted,
        timezone: tz_name,
        offset_minutes,
        unix: now.timestamp(),
        weekday,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Deserialize, Default)]
struct DdgTopic {
    #[serde(default, rename = "Text")]
    text: String,
    #[serde(default, rename = "FirstURL")]
    first_url: String,
    #[serde(default, rename = "Topics")]
    topics: Vec<DdgTopic>,
}

#[derive(Debug, Deserialize, Default)]
struct DdgResponse {
    #[serde(default, rename = "AbstractText")]
    abstract_text: String,
    #[serde(default, rename = "AbstractURL")]
    abstract_url: String,
    #[serde(default, rename = "Answer")]
    answer: String,
    #[serde(default, rename = "Heading")]
    heading: String,
    #[serde(default, rename = "RelatedTopics")]
    related_topics: Vec<DdgTopic>,
}

fn flatten_topics(topics: &[DdgTopic], out: &mut Vec<SearchResult>, limit: usize) {
    for topic in topics {
        if out.len() >= limit {
            return;
        }
        if !topic.text.is_empty() && !topic.first_url.is_empty() {
            out.push(SearchResult {
                title: topic.text.chars().take(90).collect(),
                url: topic.first_url.clone(),
                snippet: topic.text.clone(),
            });
        }
        if !topic.topics.is_empty() {
            flatten_topics(&topic.topics, out, limit);
        }
    }
}

/// Query the DuckDuckGo Instant Answer API. Free and keyless.
pub async fn web_search(
    http: &reqwest::Client,
    query: &str,
    max_results: Option<u32>,
) -> Result<Vec<SearchResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::other("search query is empty"));
    }
    let limit = max_results.unwrap_or(5).clamp(1, 10) as usize;

    let resp = http
        .get("https://api.duckduckgo.com/")
        .query(&[
            ("q", query),
            ("format", "json"),
            ("no_html", "1"),
            ("skip_disambig", "1"),
            ("t", "lilo"),
        ])
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::other(format!(
            "search failed with status {}",
            status.as_u16()
        )));
    }
    let parsed: DdgResponse = resp.json().await?;

    let mut results: Vec<SearchResult> = Vec::new();
    if !parsed.answer.is_empty() {
        results.push(SearchResult {
            title: parsed.heading.clone(),
            url: parsed.abstract_url.clone(),
            snippet: parsed.answer.clone(),
        });
    }
    if !parsed.abstract_text.is_empty() && results.len() < limit {
        results.push(SearchResult {
            title: if parsed.heading.is_empty() {
                query.to_string()
            } else {
                parsed.heading.clone()
            },
            url: parsed.abstract_url.clone(),
            snippet: parsed.abstract_text.clone(),
        });
    }
    flatten_topics(&parsed.related_topics, &mut results, limit);
    results.truncate(limit);

    if results.is_empty() {
        return Ok(vec![SearchResult {
            title: "No instant answer found".to_string(),
            url: format!(
                "https://duckduckgo.com/?q={}",
                query.replace(' ', "+")
            ),
            snippet: format!(
                "DuckDuckGo returned no instant answer for \"{query}\". Open the link to search manually."
            ),
        }]);
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptors_are_well_formed() {
        let tools = BuiltinTools::describe();
        for tool in &tools {
            assert!(!tool.name.is_empty());
            assert!(!tool.description.is_empty());
            assert!(tool.parameters["type"] == "object");
            assert!(tool.parameters["properties"].is_object());
        }
        let names: Vec<_> = tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"get_current_time"));
        assert!(names.contains(&"web_search"));
    }

    #[test]
    fn descriptor_names_are_unique() {
        let mut names: Vec<_> = BuiltinTools::describe()
            .iter()
            .map(|t| t.name.clone())
            .collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total);
    }

    #[test]
    fn current_time_utc_is_stable() {
        let t = current_time(Some("UTC")).unwrap();
        assert_eq!(t.timezone, "UTC");
        assert_eq!(t.offset_minutes, 0);
        assert!(t.iso.ends_with("+00:00"));
        assert!(t.unix > 1_600_000_000);
        assert!(!t.weekday.is_empty());
    }

    #[test]
    fn current_time_respects_named_zone() {
        let t = current_time(Some("Asia/Tokyo")).unwrap();
        assert_eq!(t.timezone, "Asia/Tokyo");
        assert_eq!(t.offset_minutes, 9 * 60);
    }

    #[test]
    fn current_time_defaults_to_local() {
        let t = current_time(None).unwrap();
        assert!(!t.timezone.is_empty());
    }

    #[test]
    fn current_time_rejects_bad_zone() {
        assert!(current_time(Some("Mars/Olympus")).is_err());
    }

    #[test]
    fn timezone_lookup_is_case_insensitive() {
        let t = current_time(Some("europe/rome")).unwrap();
        assert_eq!(t.timezone, "Europe/Rome");

        let t2 = current_time(Some("  america/new_york ")).unwrap();
        assert_eq!(t2.timezone, "America/New_York");

        assert_eq!(parse_timezone("utc").unwrap().name(), "UTC");
    }

    #[test]
    fn timezone_lookup_accepts_spaces() {
        assert_eq!(parse_timezone("Europe/Rome").unwrap().name(), "Europe/Rome");
        assert!(parse_timezone("not a zone").is_err());
    }

    #[test]
    fn flatten_topics_respects_limit() {
        let topics = vec![
            DdgTopic {
                text: "a".into(),
                first_url: "https://a".into(),
                topics: vec![],
            },
            DdgTopic {
                text: "b".into(),
                first_url: "https://b".into(),
                topics: vec![],
            },
        ];
        let mut out = Vec::new();
        flatten_topics(&topics, &mut out, 1);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn flatten_topics_recurses() {
        let topics = vec![DdgTopic {
            text: String::new(),
            first_url: String::new(),
            topics: vec![DdgTopic {
                text: "nested".into(),
                first_url: "https://n".into(),
                topics: vec![],
            }],
        }];
        let mut out = Vec::new();
        flatten_topics(&topics, &mut out, 5);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].snippet, "nested");
    }
}
