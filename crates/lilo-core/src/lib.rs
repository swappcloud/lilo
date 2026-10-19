//! LILO core — everything that must run without a window.
//!
//! The desktop app (`src-tauri`) and the headless daemon both build on this
//! crate. It must never gain a `tauri` dependency: the headless Linux device target has
//! no WebView, so anything living here has to stand on its own.

pub mod accounts;
pub mod error;
pub mod location;
pub mod mood;
pub mod persona;
pub mod plugins;
pub mod refresh;
pub mod satellite;
pub mod settings;
pub mod storage;
pub mod tools;
pub mod wake;
pub mod weather;

pub use error::{AppError, Result};
pub mod commands;
pub mod media;
