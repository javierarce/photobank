//! Debug builds never reuse the installed application's catalog or credentials.
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn isolated(path: PathBuf) -> PathBuf {
    if cfg!(debug_assertions) {
        path.join("development")
    } else {
        path
    }
}

pub fn data(app: &AppHandle) -> PathBuf {
    isolated(app.path().app_data_dir().expect("app data directory"))
}

pub fn cache(app: &AppHandle) -> PathBuf {
    isolated(app.path().app_cache_dir().expect("app cache directory"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_development_uses_a_separate_storage_root() {
        let expected = if cfg!(debug_assertions) {
            "example/development"
        } else {
            "example"
        };
        assert_eq!(
            super::isolated("example".into()),
            std::path::PathBuf::from(expected)
        );
    }
}
