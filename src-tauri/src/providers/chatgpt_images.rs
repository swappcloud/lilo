//! Pictures ChatGPT made in a voice conversation, fetched for the main window.
//!
//! The adapter finds a generated picture's file id on the data channel
//! (`app/src/providers/chatgpt/images.ts`); this downloads it with the
//! account's own session and hands back the bytes as base64. The token never
//! leaves the host.

use base64::Engine as _;

use crate::accounts;
use crate::error::AppError;
use crate::AppState;

#[derive(serde::Serialize)]
pub struct GeneratedImage {
    mime: String,
    data: String,
}

#[tauri::command]
pub async fn chatgpt_generated_image(
    state: tauri::State<'_, AppState>,
    file_id: String,
    conversation_id: Option<String>,
) -> Result<GeneratedImage, AppError> {
    let account = state
        .accounts
        .pick(accounts::PROVIDER_CHATGPT, None)
        .ok_or(AppError::NoAccount)?;
    let settings = state.settings.get();
    let (bytes, mime) = state
        .gateway
        .download_image(&settings, &account, &file_id, conversation_id.as_deref())
        .await?;
    crate::logging::log(
        "chatgpt-web",
        &format!(
            "generated image {file_id} downloaded ({} bytes, {mime})",
            bytes.len()
        ),
    );
    Ok(GeneratedImage {
        mime,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
