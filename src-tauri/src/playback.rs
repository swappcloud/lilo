//! A tool result asks LILO to play something.
//!
//! Any tool result carrying `play: { track, artist }` means "play this", the
//! same any-tool-result convention as `scene`, `mood` and `screen`. The host
//! runs it through `media_play`, the voice command's own search, so a plugin
//! names a song and never hands the player a URL of its own choosing.

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::AppState;

/// Take the `play` field out of a tool result and start it. The result gains
/// the media result's `endSession`, so replaying a song during a call ends the
/// call exactly as asking for one by voice does.
pub async fn publish(
    app: &AppHandle,
    state: &AppState,
    value: &mut serde_json::Value,
) -> Result<(), AppError> {
    let Some(play) = value
        .as_object_mut()
        .and_then(|fields| fields.remove("play"))
    else {
        return Ok(());
    };
    let Some(args) = media_args(&play) else {
        return Err(AppError::other("the song to play names no track or artist"));
    };
    let playing = state.media.run_tool("media_play", &args).await?;
    if playing
        .get("endSession")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        let _ = app.emit(crate::EVENT_END_SESSION, "media_play");
    }
    Ok(())
}

/// `media_play` arguments from a `play` request: only `track` and `artist`
/// cross over, and at least one of them must say something.
fn media_args(play: &serde_json::Value) -> Option<serde_json::Value> {
    let text = |key: &str| {
        play.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let track = text("track");
    let artist = text("artist");
    if track.is_none() && artist.is_none() {
        return None;
    }
    let mut args = serde_json::Map::new();
    if let Some(track) = track {
        args.insert("track".into(), track.into());
    }
    if let Some(artist) = artist {
        args.insert("artist".into(), artist.into());
    }
    Some(args.into())
}

#[cfg(test)]
mod tests {
    use super::media_args;
    use serde_json::json;

    #[test]
    fn only_track_and_artist_reach_the_player() {
        let args = media_args(&json!({
            "track": " Ordinary ",
            "artist": "Alex Warren",
            "url": "file:///etc/passwd"
        }))
        .unwrap();
        assert_eq!(
            args,
            json!({ "track": "Ordinary", "artist": "Alex Warren" })
        );
    }

    #[test]
    fn a_request_that_names_nothing_is_refused() {
        assert!(media_args(&json!({ "track": "  " })).is_none());
        assert!(media_args(&json!("just a string")).is_none());
    }
}
