use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("no ChatGPT account configured — add one in Settings first")]
    NoAccount,

    #[error("gateway error: {0}")]
    Gateway(String),

    #[error("{0}")]
    Other(String),

    /// A tool (or plugin) answered, and the answer was a failure. The
    /// conversation with it is still healthy, unlike a timeout or a crash.
    #[error("{0}")]
    Tool(String),
}

impl AppError {
    pub fn gateway(msg: impl Into<String>) -> Self {
        AppError::Gateway(msg.into())
    }

    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }
}

/// Tauri requires command errors to be `Serialize`; we surface the display string.
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
