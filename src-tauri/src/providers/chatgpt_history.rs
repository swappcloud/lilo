//! Read the active branch of the user's linked ChatGPT conversation.

use crate::error::AppError;
use crate::AppState;
use tauri::Manager;

pub fn build_history_script(request_id: &str, conversation_id: &str) -> Result<String, String> {
    if conversation_id.is_empty()
        || conversation_id.len() > 200
        || !conversation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid ChatGPT conversation id".into());
    }
    Ok(HISTORY_SCRIPT
        .replace(
            "__REQUEST__",
            &serde_json::to_string(request_id).map_err(|error| error.to_string())?,
        )
        .replace(
            "__CONVERSATION__",
            &serde_json::to_string(conversation_id).map_err(|error| error.to_string())?,
        ))
}

#[tauri::command]
pub async fn chatgpt_conversation_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<serde_json::Value, AppError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let script = build_history_script(&request_id, &conversation_id).map_err(AppError::gateway)?;
    let backend =
        crate::providers::backend(crate::accounts::PROVIDER_CHATGPT).ok_or(AppError::NoAccount)?;
    backend.ensure_host(&app)?;
    if !backend.host_ready() {
        return Err(AppError::gateway("ChatGPT history host is still loading"));
    }
    let window = app
        .get_webview_window(super::chatgpt::WINDOW_LABEL)
        .ok_or(AppError::NoAccount)?;
    let receiver = state.bridge.register(&request_id);
    if let Err(error) = window.eval(&script) {
        state.bridge.cancel(&request_id);
        return Err(AppError::gateway(error.to_string()));
    }
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), receiver).await;
    state.bridge.cancel(&request_id);
    match response {
        Ok(Ok(Ok(json))) => {
            serde_json::from_str(&json).map_err(|error| AppError::gateway(error.to_string()))
        }
        Ok(Ok(Err(error))) => Err(AppError::gateway(error)),
        _ => Err(AppError::gateway("ChatGPT history sync did not complete")),
    }
}

const HISTORY_SCRIPT: &str = r#"
(async () => {
  const requestId = __REQUEST__;
  const conversationId = __CONVERSATION__;
  const report = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    window.location.href = 'tauri-voice://wm-result#' + requestId + ':' + btoa(binary);
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const auth = await fetch('/api/auth/session', { credentials: 'include', signal: controller.signal });
    if (!auth.ok) throw new Error('ChatGPT sign-in is unavailable');
    const session = await auth.json();
    if (!session.accessToken) throw new Error('ChatGPT is not signed in');
    const response = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
      credentials: 'include', signal: controller.signal,
      headers: { authorization: 'Bearer ' + session.accessToken, accept: 'application/json' },
    });
    if (!response.ok) throw new Error('ChatGPT history status ' + response.status);
    const data = await response.json();
    const mapping = data.mapping || {};
    const seen = new Set(); const turns = [];
    let nodeId = data.current_node;
    let chars = 0;
    while (nodeId && !seen.has(nodeId) && seen.size < 1000 && turns.length < 200) {
      seen.add(nodeId);
      const node = mapping[nodeId]; if (!node) break;
      const message = node.message;
      const role = message && message.author && message.author.role;
      if (role === 'user' || role === 'assistant') {
        const parts = message.content && message.content.parts;
        const text = Array.isArray(parts) ? parts.map((part) => typeof part === 'string' ? part : part && (part.text || part.transcript) || '').filter((part) => typeof part === 'string').join('\n') : '';
        if (text.trim() && message.id) {
          const bounded = text.slice(0, 16000);
          if (chars + bounded.length > 96000) break;
          chars += bounded.length;
          turns.unshift({ id: message.id, speaker: role, text: bounded, final: true, timestamp: Number.isFinite(message.create_time) ? message.create_time * 1000 : Date.now() });
        }
      }
      nodeId = node.parent;
    }
    const result = { conversationId, parentMessageId: data.current_node, turns };
    while (JSON.stringify(result).length > 128000 && result.turns.length) result.turns.shift();
    report({ ok: true, answerSdp: JSON.stringify(result) });
  } catch (_) {
    report({ ok: false, error: 'Could not sync the linked ChatGPT conversation' });
  } finally { clearTimeout(timer); }
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_request_validates_and_escapes_ids() {
        assert!(build_history_script("request", "../invalid").is_err());
        let script = build_history_script("request", "chat-123").unwrap();
        assert!(script.contains("/backend-api/conversation/"));
        assert!(script.contains("current_node"));
        assert!(script.contains("new Set()"));
        assert!(script.contains("128000"));
        assert!(script.contains("chat-123"));
    }
}
