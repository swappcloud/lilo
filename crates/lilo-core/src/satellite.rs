//! The satellite link: PCM16 16 kHz mono over TCP, and the WAV files the test
//! fixtures use.
//!
//! `docs/command-protocol.md` §9: the desktop holds the ChatGPT session
//! because only a webview can; the Pi has no microphone of its own yet, so it
//! sends what it heard and plays back what the assistant says. This module is
//! the contract both ends speak — a length-prefixed frame per message, no codec
//! and no base64, so the board spends its CPU on the models.
//!
//! ```text
//! frame: kind (1 byte) | length (4 bytes, big endian) | payload
//!   hello      the pairing key, first frame from the client
//!   activate   the physical button: start a session
//!   audio_in   PCM16 the assistant should hear
//!   audio_out  PCM16 the assistant said
//!   ready      the desktop's session is up: speak now
//!   bye        the desktop finished the answer
//! ```

use tokio::io::{AsyncRead, AsyncReadExt};

pub const KIND_HELLO: u8 = 0;
pub const KIND_ACTIVATE: u8 = 1;
pub const KIND_AUDIO_IN: u8 = 2;
pub const KIND_AUDIO_OUT: u8 = 3;
pub const KIND_BYE: u8 = 4;
/// The desktop is connected and listening: the client may speak now. Without
/// this the phrase races the session setup and is lost — the model never hears
/// a session that is not up yet.
pub const KIND_READY: u8 = 5;

/// Sample rate of every stream in the link.
pub const RATE: u32 = 16_000;
/// 40 ms of mono PCM16 — the chunk the voice code uses everywhere.
pub const CHUNK_SAMPLES: usize = 640;
/// A frame larger than this is a broken peer, not audio. 40 ms is 1280 bytes;
/// a megabyte leaves room for a whole phrase in one frame while staying bounded.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// One frame on the wire.
pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Read one frame. `Ok(None)` is a clean end of stream.
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<Option<(u8, Vec<u8>)>>
where
    R: AsyncRead + Unpin,
{
    let mut head = [0u8; 5];
    match reader.read_exact(&mut head).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame of {length} bytes is too large"),
        ));
    }
    let mut payload = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut payload).await?;
    }
    Ok(Some((head[0], payload)))
}

/// PCM16 little-endian bytes to samples.
pub fn bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// Samples to PCM16 little-endian bytes.
pub fn samples_to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// The 44-byte WAV header for `data_bytes` of 16 kHz mono PCM16.
pub fn wav_header(data_bytes: u32) -> [u8; 44] {
    let mut header = [0u8; 44];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    header[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    header[24..28].copy_from_slice(&RATE.to_le_bytes());
    header[28..32].copy_from_slice(&(RATE * 2).to_le_bytes()); // byte rate
    header[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    header[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

/// Read a 16 kHz mono PCM16 WAV. Anything else is an error, not a guess: the
/// file is a fixture, and resampling it silently would make a test lie.
pub fn read_wav(path: &std::path::Path) -> crate::Result<Vec<i16>> {
    let bytes = std::fs::read(path).map_err(|error| {
        crate::AppError::other(format!("could not read {}: {error}", path.display()))
    })?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(crate::AppError::other(format!(
            "{} is not a WAV file",
            path.display()
        )));
    }
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let body = offset + 8;
        let end = (body + size).min(bytes.len());
        match id {
            b"fmt " if size >= 16 => {
                format = Some((
                    u16::from_le_bytes([bytes[body], bytes[body + 1]]),
                    u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]),
                    u32::from_le_bytes([
                        bytes[body + 4],
                        bytes[body + 5],
                        bytes[body + 6],
                        bytes[body + 7],
                    ]),
                    u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]),
                ));
            }
            b"data" => data = Some(&bytes[body..end]),
            _ => {}
        }
        offset = body + size + (size & 1);
    }
    let (tag, channels, rate, bits) = format
        .ok_or_else(|| crate::AppError::other(format!("{} has no fmt chunk", path.display())))?;
    if tag != 1 || channels != 1 || bits != 16 {
        return Err(crate::AppError::other(format!(
            "{} must be 16-bit mono PCM (it is tag={tag} channels={channels} bits={bits})",
            path.display()
        )));
    }
    if rate != RATE {
        return Err(crate::AppError::other(format!(
            "{} must be {RATE} Hz (it is {rate} Hz)",
            path.display()
        )));
    }
    let data = data
        .ok_or_else(|| crate::AppError::other(format!("{} has no data chunk", path.display())))?;
    Ok(bytes_to_samples(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips() {
        let frame = encode(KIND_AUDIO_IN, &[1, 2, 3, 4]);
        assert_eq!(frame[0], KIND_AUDIO_IN);
        assert_eq!(&frame[1..5], &[0, 0, 0, 4]);
        assert_eq!(&frame[5..], &[1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn frames_read_back_in_order() {
        let mut wire = Vec::new();
        wire.extend_from_slice(&encode(KIND_HELLO, b"key"));
        wire.extend_from_slice(&encode(KIND_ACTIVATE, &[]));
        wire.extend_from_slice(&encode(KIND_AUDIO_OUT, &[9, 9]));
        let mut reader = std::io::Cursor::new(wire);

        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some((KIND_HELLO, b"key".to_vec()))
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some((KIND_ACTIVATE, Vec::new()))
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some((KIND_AUDIO_OUT, vec![9, 9]))
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            None,
            "clean end of stream"
        );
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused() {
        let mut wire = encode(KIND_AUDIO_IN, &[]);
        wire[1..5].copy_from_slice(&(MAX_FRAME_BYTES as u32 + 1).to_be_bytes());
        let error = read_frame(&mut std::io::Cursor::new(wire))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("too large"), "{error}");
    }

    #[test]
    fn pcm16_bytes_survive_the_round_trip() {
        let samples = vec![0i16, 1, -1, 32767, -32768];
        assert_eq!(bytes_to_samples(&samples_to_bytes(&samples)), samples);
    }

    #[test]
    fn a_wav_written_from_samples_reads_back() {
        let dir = std::env::temp_dir().join(format!("lilo-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("answer.wav");
        let samples: Vec<i16> = (0..2000).map(|i| ((i * 7) % 500) as i16).collect();
        let mut file = std::fs::File::create(&path).unwrap();
        use std::io::Write;
        file.write_all(&wav_header(samples_to_bytes(&samples).len() as u32))
            .unwrap();
        file.write_all(&samples_to_bytes(&samples)).unwrap();
        drop(file);

        assert_eq!(read_wav(&path).unwrap(), samples);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wav_of_the_wrong_shape_is_refused() {
        let dir = std::env::temp_dir().join(format!("lilo-link-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stereo.wav");
        let mut bytes = Vec::from(wav_header(8));
        bytes.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        bytes[22] = 2; // channels
        std::fs::write(&path, &bytes).unwrap();
        let error = read_wav(&path).unwrap_err().to_string();
        assert!(error.contains("16-bit mono PCM"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
