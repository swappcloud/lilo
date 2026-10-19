//! Keep the sign-in page rendering while the phone drives its form.
//!
//! WebKit treats the page of a hidden window as hidden (`document.hidden`)
//! and stops rendering parts of it: ChatGPT's phone step never even mounts.
//! When the phone drives a login, its window is shown cloaked instead —
//! fully transparent and click-through on macOS, off-screen on Linux — and
//! uncloaked before anyone is meant to see it.
//! Windows keeps phone login on screen: an off-screen WebView2 can stop
//! rendering the form even though the same page works in a visible window.

use tauri::WebviewWindow;

/// Shows `window` with the platform's phone-login presentation.
pub fn cloak(window: &WebviewWindow) {
    imp::cloak(window);
}

/// Puts `window` back where a person can see and use it. Does not show it.
pub fn uncloak(window: &WebviewWindow) {
    imp::uncloak(window);
}

#[cfg(any(not(target_os = "macos"), test))]
fn offscreen_allowed(platform: &str) -> bool {
    platform == "linux"
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_phone_login_must_stay_on_screen() {
        assert!(!super::offscreen_allowed("windows"));
        assert!(super::offscreen_allowed("linux"));
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use tauri::WebviewWindow;

    pub fn cloak(window: &WebviewWindow) {
        let _ = window.with_webview(|webview| unsafe {
            let ns_window = webview.ns_window().cast::<AnyObject>();
            if ns_window.is_null() {
                return;
            }
            let view = webview.inner().cast::<AnyObject>();
            let _: () = msg_send![ns_window, setAlphaValue: 0.0f64];
            let _: () = msg_send![ns_window, setIgnoresMouseEvents: true];
            // A window other windows cover is "occluded", and WebKit hides its
            // page again. The switch is private, so it is asked for first.
            let switch = sel!(_setWindowOcclusionDetectionEnabled:);
            let has_switch: bool = msg_send![view, respondsToSelector: switch];
            if has_switch {
                let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
            }
            // On screen without becoming the key window: focus stays put.
            let _: () = msg_send![ns_window, orderFront: std::ptr::null_mut::<AnyObject>()];
        });
    }

    pub fn uncloak(window: &WebviewWindow) {
        let _ = window.with_webview(|webview| unsafe {
            let ns_window = webview.ns_window().cast::<AnyObject>();
            if ns_window.is_null() {
                return;
            }
            let _: () = msg_send![ns_window, setIgnoresMouseEvents: false];
            let _: () = msg_send![ns_window, setAlphaValue: 1.0f64];
        });
        let _ = window.center();
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{PhysicalPosition, WebviewWindow};

    /// Linux can render a shown WebKitGTK page outside the desktop.
    const AWAY: PhysicalPosition<i32> = PhysicalPosition {
        x: -32000,
        y: -32000,
    };

    pub fn cloak(window: &WebviewWindow) {
        if super::offscreen_allowed(std::env::consts::OS) {
            let _ = window.set_skip_taskbar(true);
            let _ = window.set_position(AWAY);
        } else {
            let _ = window.set_skip_taskbar(false);
            let _ = window.center();
            let _ = window.unminimize();
        }
        let _ = window.show();
    }

    pub fn uncloak(window: &WebviewWindow) {
        let _ = window.set_skip_taskbar(false);
        let _ = window.center();
    }
}
