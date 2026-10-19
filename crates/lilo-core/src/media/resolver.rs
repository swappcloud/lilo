//! Turning "a song by Djavan" into something a player can open.
//!
//! Two backends, chosen by what the host can afford:
//!   * `YtDlp` — robust, but spawns Python. Fine on a desktop.
//!   * `Http`  — one or two plain HTTP calls against a Piped instance, no
//!     Python at all, and it hands mpv a direct audio URL so mpv does not need
//!     yt-dlp either. This is the headless Linux device path.
//!
//! Dispatch is an enum rather than `dyn Resolver`: it keeps the crate free of
//! `async-trait`, and enum dispatch is cheaper on ARM. Adding Spotify later is
//! a new variant plus its parser.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    pub track: Option<String>,
    pub artist: Option<String>,
    pub limit: usize,
}

impl Query {
    /// Build the search string. Asking for an artist alone deliberately biases
    /// the search toward songs rather than interviews or live streams.
    pub fn search_terms(&self) -> String {
        match (self.track.as_deref(), self.artist.as_deref()) {
            (Some(track), Some(artist)) => format!("{track} {artist}"),
            (Some(track), None) => track.to_string(),
            (None, Some(artist)) => format!("{artist} songs"),
            (None, None) => String::new(),
        }
    }

    /// How many results to ask for. An artist request becomes a small queue so
    /// "next" has somewhere to go; a named track only needs the top hit.
    pub fn effective_limit(&self) -> usize {
        if self.limit > 0 {
            self.limit.clamp(1, 25)
        } else if self.track.is_some() {
            1
        } else {
            10
        }
    }

    pub fn is_empty(&self) -> bool {
        self.search_terms().trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// What the player should open. For `YtDlp` this is the watch page (mpv's
    /// ytdl hook handles it); for `Http` it is already a direct audio stream.
    pub url: String,
    pub duration_secs: Option<u64>,
    /// Artwork from a canonical YouTube thumbnail URL derived from `id`.
    pub artwork_url: Option<String>,
}

/// Accept only public YouTube video IDs. This keeps callers from turning a
/// selected result into an arbitrary URL or a request to a private host.
pub fn validate_video_id(id: &str) -> Result<()> {
    if id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Ok(())
    } else {
        Err(AppError::other("invalid YouTube video id"))
    }
}

fn artwork_url(id: &str) -> Option<String> {
    validate_video_id(id)
        .ok()
        .map(|_| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
}

// --- yt-dlp ----------------------------------------------------------------

/// Parse `yt-dlp --dump-json` output: one JSON object per line. Unparseable
/// lines are skipped rather than failing the whole search — yt-dlp mixes
/// warnings into stdout on some builds.
pub fn parse_ytdlp_lines(stdout: &str) -> Vec<Track> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter_map(|value| {
            let id = value.get("id")?.as_str()?.to_string();
            validate_video_id(&id).ok()?;
            let title = value
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let artist = value
                .get("artist")
                .or_else(|| value.get("uploader"))
                .or_else(|| value.get("channel"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            Some(Track {
                url: format!("https://www.youtube.com/watch?v={id}"),
                id: id.clone(),
                title,
                artist,
                duration_secs: value
                    .get("duration")
                    .and_then(|v| v.as_f64())
                    .map(|d| d as u64),
                artwork_url: artwork_url(&id),
            })
        })
        .collect()
}

// --- Piped -----------------------------------------------------------------

/// Extract the video id from a Piped item url (`/watch?v=ID`).
fn piped_id(url: &str) -> Option<String> {
    url.split("v=")
        .nth(1)
        .map(|rest| rest.split(['&', '#']).next().unwrap_or(rest).to_string())
}

pub fn parse_piped_search(body: &serde_json::Value) -> Vec<Track> {
    let items = body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .iter()
        .filter_map(|item| {
            let url = item.get("url")?.as_str()?;
            let id = piped_id(url)?;
            validate_video_id(&id).ok()?;
            Some(Track {
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                artist: item
                    .get("uploaderName")
                    .or_else(|| item.get("uploader"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                duration_secs: item
                    .get("duration")
                    .and_then(|v| v.as_i64())
                    .filter(|d| *d > 0)
                    .map(|d| d as u64),
                url: format!("https://www.youtube.com/watch?v={id}"),
                id: id.clone(),
                artwork_url: artwork_url(&id),
            })
        })
        .collect()
}

fn track_from_piped_stream(id: &str, body: &serde_json::Value) -> Result<Track> {
    validate_video_id(id)?;
    Ok(Track {
        id: id.to_string(),
        title: body
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        artist: body
            .get("uploader")
            .or_else(|| body.get("uploaderName"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        url: format!("https://www.youtube.com/watch?v={id}"),
        duration_secs: body.get("duration").and_then(|value| value.as_u64()),
        artwork_url: artwork_url(id),
    })
}

/// Pick the cheapest usable audio stream from a Piped `/streams/{id}` payload.
///
/// Bitrate matters on a Pi: the lowest stream at or above 96 kbps keeps the
/// sound quality acceptable without spending bandwidth the board cannot spare.
pub fn pick_audio_stream(body: &serde_json::Value) -> Option<String> {
    let streams = body.get("audioStreams")?.as_array()?;
    let mut best: Option<(i64, &str)> = None;
    for stream in streams {
        let url = stream.get("url").and_then(|v| v.as_str())?;
        let bitrate = stream.get("bitrate").and_then(|v| v.as_i64()).unwrap_or(0);
        let acceptable = (96_000..=160_000).contains(&bitrate);
        let better = match best {
            None => true,
            Some((current, _)) => {
                if acceptable {
                    !(96_000..=160_000).contains(&current) || bitrate < current
                } else {
                    false
                }
            }
        };
        if better {
            best = Some((bitrate, url));
        }
    }
    best.map(|(_, url)| url.to_string())
}

/// Tracks Piped lists as related to a video (`/streams/{id}` → `relatedStreams`).
/// Playlists and channels share that list; only playable videos are kept.
pub fn parse_piped_related(body: &serde_json::Value) -> Vec<Track> {
    let streams: Vec<serde_json::Value> = body
        .get("relatedStreams")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("stream")
                        == "stream"
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    parse_piped_search(&serde_json::json!({ "items": streams }))
}

/// YouTube's own "Mix" for a video: the auto-generated playlist of related
/// songs that YouTube plays after it, seeded by the video itself.
pub fn mix_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}&list=RD{video_id}")
}

/// Drop the seed and anything already queued, keeping the first `limit`.
/// A mix always starts with its seed, and repeats are what makes a radio
/// sound broken.
pub fn fresh_tracks(tracks: Vec<Track>, known: &[String], limit: usize) -> Vec<Track> {
    let mut seen: Vec<String> = known.to_vec();
    let mut fresh = Vec::new();
    for track in tracks {
        if fresh.len() >= limit {
            break;
        }
        if seen.contains(&track.id) {
            continue;
        }
        seen.push(track.id.clone());
        fresh.push(track);
    }
    fresh
}

// --- dispatch --------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Resolver {
    YtDlp {
        bin: PathBuf,
        runtime: Option<PathBuf>,
    },
    Http {
        base_url: String,
    },
}

impl Resolver {
    pub fn id(&self) -> &'static str {
        match self {
            Resolver::YtDlp { .. } => "yt-dlp",
            Resolver::Http { .. } => "http",
        }
    }

    pub async fn search(&self, http: &reqwest::Client, query: &Query) -> Result<Vec<Track>> {
        if query.is_empty() {
            return Err(AppError::other("nothing to search for"));
        }
        match self {
            Resolver::YtDlp { bin, runtime } => {
                self.search_ytdlp(bin, runtime.as_deref(), query).await
            }
            Resolver::Http { base_url } => self.search_http(http, base_url, query).await,
        }
    }

    /// Search metadata for a picker without resolving a playable stream.
    pub async fn search_catalog(
        &self,
        http: &reqwest::Client,
        query: &Query,
    ) -> Result<Vec<Track>> {
        if query.is_empty() {
            return Err(AppError::other("nothing to search for"));
        }
        match self {
            Resolver::YtDlp { bin, runtime } => {
                self.search_ytdlp(bin, runtime.as_deref(), query).await
            }
            Resolver::Http { base_url } => self.search_http_catalog(http, base_url, query).await,
        }
    }

    /// Resolve one previously selected public YouTube video ID without
    /// repeating a text search. The ID is the only client supplied selector.
    pub async fn resolve_id(&self, http: &reqwest::Client, id: &str) -> Result<Track> {
        validate_video_id(id)?;
        match self {
            Resolver::YtDlp { bin, runtime } => {
                let url = format!("https://www.youtube.com/watch?v={id}");
                let mut command = super::process::quiet_command(bin);
                super::process::javascript_runtime(&mut command, runtime.as_deref())?;
                command.args([
                    "--dump-single-json",
                    "--no-warnings",
                    "--no-playlist",
                    "--quiet",
                    &url,
                ]);
                let output =
                    super::process::output(command, std::time::Duration::from_secs(45)).await?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(AppError::other(format!(
                        "yt-dlp failed: {}",
                        stderr.lines().last().unwrap_or("unknown error").trim()
                    )));
                }
                let tracks = parse_ytdlp_lines(&String::from_utf8_lossy(&output.stdout));
                tracks
                    .into_iter()
                    .find(|track| track.id == id)
                    .ok_or_else(|| AppError::other("selected YouTube video was not found"))
            }
            Resolver::Http { base_url } => {
                let base = base_url.trim_end_matches('/');
                let body: serde_json::Value = http
                    .get(format!("{base}/streams/{id}"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let mut track = track_from_piped_stream(id, &body)?;
                track.url = pick_audio_stream(&body)
                    .ok_or_else(|| AppError::other("selected video has no playable audio"))?;
                Ok(track)
            }
        }
    }

    /// Songs related to `seed`, the way YouTube keeps playing after a video.
    /// Excludes `known` ids (the seed and whatever is already queued).
    pub async fn related(
        &self,
        http: &reqwest::Client,
        seed: &Track,
        known: &[String],
        limit: usize,
    ) -> Result<Vec<Track>> {
        let tracks = match self {
            Resolver::YtDlp { bin, runtime } => {
                // One extra: the mix opens with the seed itself.
                let end = (limit + known.len() + 1).to_string();
                let mut command = super::process::quiet_command(bin);
                super::process::javascript_runtime(&mut command, runtime.as_deref())?;
                command.args([
                    "--flat-playlist",
                    "--dump-json",
                    "--no-warnings",
                    "--yes-playlist",
                    "--quiet",
                    "--playlist-end",
                    &end,
                    &mix_url(&seed.id),
                ]);
                let output =
                    super::process::output(command, std::time::Duration::from_secs(45)).await?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(AppError::other(format!(
                        "yt-dlp failed: {}",
                        stderr.lines().last().unwrap_or("unknown error").trim()
                    )));
                }
                parse_ytdlp_lines(&String::from_utf8_lossy(&output.stdout))
            }
            Resolver::Http { base_url } => {
                let base = base_url.trim_end_matches('/');
                let body: serde_json::Value = http
                    .get(format!("{base}/streams/{}", seed.id))
                    .send()
                    .await?
                    .json()
                    .await?;
                parse_piped_related(&body)
            }
        };
        let mut known = known.to_vec();
        known.push(seed.id.clone());
        let fresh = fresh_tracks(tracks, &known, limit);
        if fresh.is_empty() {
            return Err(AppError::other(format!(
                "no related songs found for \"{}\"",
                seed.title
            )));
        }
        Ok(fresh)
    }

    async fn search_ytdlp(
        &self,
        bin: &PathBuf,
        runtime: Option<&std::path::Path>,
        query: &Query,
    ) -> Result<Vec<Track>> {
        let limit = query.effective_limit();
        let search = format!("ytsearch{limit}:{}", query.search_terms());
        let mut command = super::process::quiet_command(bin);
        super::process::javascript_runtime(&mut command, runtime)?;
        command.args([
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--no-playlist",
            "--quiet",
            &search,
        ]);
        let output = super::process::output(command, std::time::Duration::from_secs(45)).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::other(format!(
                "yt-dlp failed: {}",
                stderr.lines().last().unwrap_or("unknown error").trim()
            )));
        }

        let tracks = parse_ytdlp_lines(&String::from_utf8_lossy(&output.stdout));
        if tracks.is_empty() {
            return Err(AppError::other(format!(
                "nothing found for \"{}\"",
                query.search_terms()
            )));
        }
        Ok(tracks)
    }

    async fn search_http(
        &self,
        http: &reqwest::Client,
        base_url: &str,
        query: &Query,
    ) -> Result<Vec<Track>> {
        let mut tracks = self.search_http_catalog(http, base_url, query).await?;
        let base = base_url.trim_end_matches('/');
        // Resolve only the first track for voice playback. The picker uses
        // `search_catalog` and returns immediately with metadata alone.
        let streams: serde_json::Value = http
            .get(format!("{base}/streams/{}", tracks[0].id))
            .send()
            .await?
            .json()
            .await?;
        if let Some(url) = pick_audio_stream(&streams) {
            tracks[0].url = url;
        }
        Ok(tracks)
    }

    async fn search_http_catalog(
        &self,
        http: &reqwest::Client,
        base_url: &str,
        query: &Query,
    ) -> Result<Vec<Track>> {
        let base = base_url.trim_end_matches('/');
        let body: serde_json::Value = http
            .get(format!("{base}/search"))
            .query(&[
                ("q", query.search_terms().as_str()),
                ("filter", "music_songs"),
            ])
            .send()
            .await?
            .json()
            .await?;

        let mut tracks = parse_piped_search(&body);
        tracks.truncate(query.effective_limit());
        if tracks.is_empty() {
            return Err(AppError::other(format!(
                "nothing found for \"{}\"",
                query.search_terms()
            )));
        }

        Ok(tracks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_video_ids_are_strict_and_artwork_is_canonical() {
        assert!(validate_video_id("fJ9rUzIMcZQ").is_ok());
        assert!(validate_video_id("https://example.test/stream").is_err());
        assert!(validate_video_id("short").is_err());
        assert!(validate_video_id("../../etc/passwd").is_err());
        assert_eq!(
            artwork_url("fJ9rUzIMcZQ").as_deref(),
            Some("https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg")
        );
    }

    #[test]
    fn selected_piped_stream_uses_only_service_metadata_and_id() {
        let track = track_from_piped_stream(
            "fJ9rUzIMcZQ",
            &json!({ "title": "Song", "uploader": "Artist", "duration": 12 }),
        )
        .unwrap();
        assert_eq!(track.id, "fJ9rUzIMcZQ");
        assert_eq!(track.title, "Song");
        assert_eq!(track.artist, "Artist");
        assert_eq!(track.url, "https://www.youtube.com/watch?v=fJ9rUzIMcZQ");
        assert!(track_from_piped_stream("http://127.0.0.1", &json!({})).is_err());
    }

    #[test]
    fn search_terms_cover_every_slot_combination() {
        let track_only = Query {
            track: Some("bohemian rhapsody".into()),
            ..Default::default()
        };
        assert_eq!(track_only.search_terms(), "bohemian rhapsody");

        let artist_only = Query {
            artist: Some("djavan".into()),
            ..Default::default()
        };
        assert_eq!(
            artist_only.search_terms(),
            "djavan songs",
            "an artist alone must bias toward music, not interviews"
        );

        let both = Query {
            track: Some("samurai".into()),
            artist: Some("djavan".into()),
            ..Default::default()
        };
        assert_eq!(both.search_terms(), "samurai djavan");

        assert!(Query::default().is_empty());
    }

    #[test]
    fn a_named_track_needs_one_hit_an_artist_needs_a_queue() {
        let track = Query {
            track: Some("creep".into()),
            ..Default::default()
        };
        assert_eq!(track.effective_limit(), 1);

        let artist = Query {
            artist: Some("radiohead".into()),
            ..Default::default()
        };
        assert_eq!(artist.effective_limit(), 10, "next needs somewhere to go");

        let explicit = Query {
            artist: Some("radiohead".into()),
            limit: 99,
            ..Default::default()
        };
        assert_eq!(explicit.effective_limit(), 25, "clamped");
    }

    #[test]
    fn ytdlp_lines_become_tracks() {
        let stdout = concat!(
            r#"{"id":"fJ9rUzIMcZQ","title":"Bohemian Rhapsody","uploader":"Queen","duration":355}"#,
            "\n",
            r#"{"id":"Abcdefghijk","title":"Another One","channel":"Queen"}"#,
            "\n",
        );
        let tracks = parse_ytdlp_lines(stdout);
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Bohemian Rhapsody");
        assert_eq!(tracks[0].artist, "Queen");
        assert_eq!(tracks[0].duration_secs, Some(355));
        assert_eq!(tracks[0].url, "https://www.youtube.com/watch?v=fJ9rUzIMcZQ");
        assert_eq!(tracks[1].artist, "Queen", "channel is a valid fallback");
    }

    #[test]
    fn ytdlp_garbage_lines_are_skipped_not_fatal() {
        let stdout = "WARNING: something\n{\"id\":\"x\",\"title\":\"T\"}\nnot json\n";
        let tracks = parse_ytdlp_lines(stdout);
        assert!(
            tracks.is_empty(),
            "invalid IDs cannot become selectable tracks"
        );
    }

    #[test]
    fn piped_search_items_become_tracks() {
        let body = json!({
            "items": [
                { "url": "/watch?v=fJ9rUzIMcZQ", "title": "Samurai", "uploaderName": "Djavan", "duration": 300 },
                { "url": "/watch?v=Abcdefghijk&t=1", "title": "Flor de Lis", "uploaderName": "Djavan" },
                { "title": "no url at all" }
            ]
        });
        let tracks = parse_piped_search(&body);
        assert_eq!(tracks.len(), 2, "items without a url are dropped");
        assert_eq!(tracks[0].id, "fJ9rUzIMcZQ");
        assert_eq!(tracks[0].artist, "Djavan");
        assert_eq!(tracks[1].id, "Abcdefghijk", "query params are stripped");
        assert_eq!(tracks[1].duration_secs, None);
        assert_eq!(
            tracks[0].artwork_url.as_deref(),
            Some("https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg")
        );
    }

    #[test]
    fn piped_search_without_items_is_empty_not_a_panic() {
        assert!(parse_piped_search(&json!({})).is_empty());
        assert!(parse_piped_search(&json!({ "items": "nope" })).is_empty());
    }

    #[test]
    fn audio_stream_picks_the_cheapest_acceptable_bitrate() {
        let body = json!({
            "audioStreams": [
                { "url": "https://a/320", "bitrate": 320000 },
                { "url": "https://a/128", "bitrate": 128000 },
                { "url": "https://a/50",  "bitrate": 50000 },
                { "url": "https://a/96",  "bitrate": 96000 }
            ]
        });
        assert_eq!(
            pick_audio_stream(&body).as_deref(),
            Some("https://a/96"),
            "a Pi should not pull 320 kbps"
        );
    }

    #[test]
    fn audio_stream_falls_back_when_nothing_is_in_range() {
        let body = json!({ "audioStreams": [{ "url": "https://a/48", "bitrate": 48000 }] });
        assert_eq!(pick_audio_stream(&body).as_deref(), Some("https://a/48"));
        assert!(pick_audio_stream(&json!({})).is_none());
    }

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            title: id.into(),
            artist: String::new(),
            url: format!("https://www.youtube.com/watch?v={id}"),
            duration_secs: None,
            artwork_url: artwork_url(id),
        }
    }

    #[test]
    fn the_mix_is_seeded_by_the_video_itself() {
        assert_eq!(
            mix_url("fJ9rUzIMcZQ"),
            "https://www.youtube.com/watch?v=fJ9rUzIMcZQ&list=RDfJ9rUzIMcZQ"
        );
    }

    #[test]
    fn related_songs_skip_the_seed_repeats_and_the_queue() {
        let tracks = vec![
            track("seed"),
            track("a"),
            track("queued"),
            track("a"),
            track("b"),
            track("c"),
        ];
        let fresh = fresh_tracks(tracks, &["seed".into(), "queued".into()], 2);
        let ids: Vec<_> = fresh.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn piped_related_keeps_only_videos() {
        let body = json!({
            "relatedStreams": [
                { "url": "/watch?v=abcdefghijk", "title": "Song", "uploaderName": "Band", "type": "stream" },
                { "url": "/playlist?list=PL1", "title": "A playlist", "type": "playlist" },
                { "url": "/watch?v=12345678901", "title": "Untyped" }
            ]
        });
        let ids: Vec<_> = parse_piped_related(&body)
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["abcdefghijk", "12345678901"]);
        assert!(parse_piped_related(&json!({})).is_empty());
    }

    /// The real mix, through the real yt-dlp:
    ///
    ///   LILO_YTDLP=/path/to/yt-dlp cargo test -p lilo-core -- --ignored related_for_real
    #[tokio::test]
    #[ignore = "network + spawns yt-dlp"]
    async fn related_for_real() {
        let bin = PathBuf::from(std::env::var("LILO_YTDLP").expect("set LILO_YTDLP"));
        let seed = track("fJ9rUzIMcZQ");
        let related = Resolver::YtDlp { bin, runtime: None }
            .related(&reqwest::Client::new(), &seed, &[], 10)
            .await
            .expect("a mix");
        for track in &related {
            eprintln!("{} — {}", track.artist, track.title);
        }
        assert_eq!(related.len(), 10);
        assert!(
            related.iter().all(|t| t.id != seed.id),
            "the seed is not its own neighbour"
        );
    }

    #[tokio::test]
    async fn an_empty_query_is_rejected_before_any_work() {
        let resolver = Resolver::Http {
            base_url: "http://127.0.0.1:1".into(),
        };
        let err = resolver
            .search(&reqwest::Client::new(), &Query::default())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("nothing to search for"));
    }

    #[test]
    fn resolver_ids_are_stable() {
        assert_eq!(
            Resolver::Http {
                base_url: String::new()
            }
            .id(),
            "http"
        );
        assert_eq!(
            Resolver::YtDlp {
                bin: PathBuf::from("/x"),
                runtime: None
            }
            .id(),
            "yt-dlp"
        );
    }
}
