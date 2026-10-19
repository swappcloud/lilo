//! Provider-neutral vision channel for locally captured plugin images.
//! The host emits bounded image bytes to the main UI; the selected adapter
//! owns any vendor upload or live video transport. No other account is used.

use tauri::{AppHandle, Emitter};

use crate::error::AppError;

/// A screenshot is ready to be shown to the model
/// (`{ dataBase64, text, name, mime, size, width, height }`).
pub const EVENT_SCREEN: &str = "lilo://screen";

/// Take the `screen` field out of a tool result and tell the
/// frontend to show it. The bytes are consumed here and must never reach the
/// log, the webview or the model's notes.
pub async fn publish(app: &AppHandle, value: &mut serde_json::Value) -> Result<(), AppError> {
    let Some(screen) = value
        .as_object_mut()
        .and_then(|fields| fields.remove("screen"))
    else {
        return Ok(());
    };
    let frame = Frame::decode(&screen)?;
    let text = screen
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let _ = app.emit(EVENT_SCREEN, frame.event(&text));
    Ok(())
}

struct Frame {
    bytes: Vec<u8>,
    mime: String,
    name: &'static str,
    size: Option<(u32, u32)>,
}

impl Frame {
    fn event(&self, text: &str) -> serde_json::Value {
        use base64::Engine as _;
        let (width, height) = self.size.unwrap_or((0, 0));
        serde_json::json!({
            "fileId": "", "dataBase64": base64::engine::general_purpose::STANDARD.encode(&self.bytes),
            "text": text, "name": self.name, "mime": self.mime,
            "size": self.bytes.len(), "width": width, "height": height,
        })
    }

    fn decode(screen: &serde_json::Value) -> Result<Self, AppError> {
        use base64::Engine as _;

        let data = screen
            .get("data")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let mime = screen
            .get("mime")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| AppError::other(format!("invalid screenshot data: {error}")))?;
        let name = if mime == "image/png" {
            "screen.png"
        } else {
            "screen.jpg"
        };
        let size = image_size(&bytes);
        Ok(Frame {
            bytes,
            mime,
            name,
            size,
        })
    }
}

/// Upload one captured frame the way the web client does, returning the
/// `file_id` a live session references as `sediment://<file_id>`.
/// Pixel size of a PNG or JPEG, read from its header. The web client sends
/// width and height with every image; a pointer without them is not shown to
/// the model. A header walk instead of an image crate: this is all we need.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(PNG) && bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height));
    }
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            return None;
        }
        let marker = bytes[pos + 1];
        // Fill bytes and standalone markers carry no length.
        if marker == 0xFF {
            pos += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            pos += 2;
            continue;
        }
        let length = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        // Start-of-frame markers (SOF0..SOF15, minus DHT/JPG/DAC) hold the size.
        let is_sof = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            if pos + 9 > bytes.len() {
                return None;
            }
            let height = u16::from_be_bytes([bytes[pos + 5], bytes[pos + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[pos + 7], bytes[pos + 8]]) as u32;
            return Some((width, height));
        }
        if length < 2 {
            return None;
        }
        pos += 2 + length;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{image_size, Frame};

    #[test]
    fn reads_a_png_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&1600u32.to_be_bytes());
        png.extend_from_slice(&1000u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((1600, 1000)));
    }

    #[test]
    fn reads_a_jpeg_frame_header_after_other_segments() {
        let jpeg = [
            0xFF, 0xD8, // SOI
            0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, // APP0, 2 bytes of payload
            0xFF, 0xC0, 0x00, 0x11, 0x08, // SOF0, precision
            0x03, 0x84, // height 900
            0x06, 0x40, // width 1600
        ];
        assert_eq!(image_size(&jpeg), Some((1600, 900)));
    }

    #[test]
    fn unknown_or_truncated_data_has_no_size() {
        assert_eq!(image_size(b"not an image"), None);
        assert_eq!(image_size(&[0xFF, 0xD8, 0xFF]), None);
    }
    #[test]
    fn test_screen_payload_is_local_and_requires_no_vendor_account() {
        use base64::Engine as _;
        let bytes = vec![0xff, 0xd8, 0xff];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let frame =
            Frame::decode(&serde_json::json!({"data": encoded, "mime": "image/jpeg"})).unwrap();
        let event = frame.event("Look at this");
        assert_eq!(event["dataBase64"], encoded);
        assert_eq!(event["fileId"], "");
        assert_eq!(event["text"], "Look at this");
        assert_eq!(event["size"], 3);
        assert!(event.get("account").is_none());
    }
}
