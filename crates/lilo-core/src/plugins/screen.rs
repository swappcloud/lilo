//! Native screen capture for `lilo.screenshot`, behind the `screen:capture`
//! capability.
//!
//! On Windows the screen plugin used to spawn PowerShell with `Add-Type
//! System.Drawing` + `CopyFromScreen` — exactly the script shape antivirus
//! engines flag as spyware (AMSI sees the whole script), so captures were
//! blocked outright. Capturing in-process with GDI, the way screen-sharing
//! apps do, spawns nothing and hands no script to a scanner. Other platforms
//! keep their system tools (`screencapture`, `grim`, …), which no one blocks.

/// The primary screen as a JPEG, scaled so its long edge is at most
/// `max_edge` pixels.
pub fn capture_jpeg(max_edge: u32) -> Result<Vec<u8>, String> {
    imp::capture_jpeg(max_edge.max(1))
}

/// Target size for a `width`×`height` frame whose long edge may not exceed
/// `max_edge`; never upscaled, never zero.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows capture scales
fn scaled(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let long = width.max(height).max(1);
    if long <= max_edge {
        return (width.max(1), height.max(1));
    }
    let scale = max_edge as f64 / long as f64;
    let w = ((width as f64 * scale).round() as u32).max(1);
    let h = ((height as f64 * scale).round() as u32).max(1);
    (w, h)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        GetDeviceCaps, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DESKTOPHORZRES, DESKTOPVERTRES, DIB_RGB_COLORS,
        HALFTONE, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    pub fn capture_jpeg(max_edge: u32) -> Result<Vec<u8>, String> {
        // SAFETY: plain GDI calls on handles created and released here; the
        // pixel buffer is sized for the 32-bit top-down DIB GetDIBits writes.
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("could not open the screen".into());
            }
            // Physical pixels: GetSystemMetrics is DPI-virtualized in a process
            // that is not DPI-aware, which would crop a scaled display to its
            // top-left corner.
            let mut width = GetDeviceCaps(Some(screen), DESKTOPHORZRES);
            let mut height = GetDeviceCaps(Some(screen), DESKTOPVERTRES);
            if width <= 0 || height <= 0 {
                width = GetSystemMetrics(SM_CXSCREEN);
                height = GetSystemMetrics(SM_CYSCREEN);
            }
            if width <= 0 || height <= 0 {
                ReleaseDC(None, screen);
                return Err("no screen to capture".into());
            }
            let (w, h) = super::scaled(width as u32, height as u32, max_edge);
            let (w, h) = (w as i32, h as i32);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let previous = SelectObject(memory, bitmap.into());

            // Scale while copying: HALFTONE averages instead of dropping pixels.
            SetStretchBltMode(memory, HALFTONE);
            let copied = StretchBlt(
                memory,
                0,
                0,
                w,
                h,
                Some(screen),
                0,
                0,
                width,
                height,
                SRCCOPY | CAPTUREBLT,
            )
            .as_bool();

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let rows = if copied {
                SelectObject(memory, previous);
                GetDIBits(
                    memory,
                    bitmap,
                    0,
                    h as u32,
                    Some(pixels.as_mut_ptr().cast()),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                SelectObject(memory, previous);
                0
            };

            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);

            if !copied {
                return Err("could not copy the screen".into());
            }
            if rows != h {
                return Err("could not read the captured pixels".into());
            }
            encode(&pixels, w as u16, h as u16)
        }
    }

    fn encode(bgra: &[u8], width: u16, height: u16) -> Result<Vec<u8>, String> {
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 80)
            .encode(bgra, width, height, jpeg_encoder::ColorType::Bgra)
            .map_err(|error| format!("could not encode the screenshot: {error}"))?;
        Ok(jpeg)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn capture_jpeg(_max_edge: u32) -> Result<Vec<u8>, String> {
        Err("lilo.screenshot is only built in on Windows — use the system screenshot tool".into())
    }
}

#[cfg(test)]
mod tests {
    use super::scaled;

    #[test]
    fn scales_the_long_edge_down_and_never_up() {
        assert_eq!(scaled(3200, 2000, 1600), (1600, 1000));
        assert_eq!(scaled(1080, 1920, 1600), (900, 1600));
        assert_eq!(scaled(1280, 720, 1600), (1280, 720));
        assert_eq!(scaled(0, 0, 1600), (1, 1));
    }

    /// Needs a desktop session: `cargo test -p lilo-core -- --ignored screen`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn captures_the_screen_as_a_jpeg() {
        let jpeg = super::capture_jpeg(1600).expect("capture");
        assert!(jpeg.starts_with(&[0xFF, 0xD8]), "not a JPEG");
        if let Ok(path) = std::env::var("LILO_SCREENSHOT_OUT") {
            std::fs::write(path, &jpeg).unwrap();
        }
    }
}
