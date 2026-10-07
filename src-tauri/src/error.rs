use serde::{Serialize, Serializer};

/// Every error that crosses the IPC boundary becomes a human-readable string.
/// Messages are written for players, not developers: they say what failed and,
/// where possible, what to do about it.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("File error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Unexpected data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Archive error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("Cancelled")]
    Cancelled,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::Msg(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error::Msg(s.to_string())
    }
}

#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::Error::Msg(format!($($arg)*)))
    };
}
