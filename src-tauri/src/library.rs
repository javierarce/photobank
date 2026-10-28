//! One writer owns the catalog and its remote objects for an entire operation.
//! SQLite alone cannot serialize a check → S3 copy → catalog commit sequence.
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::error::{Error, Result};

#[derive(Default)]
pub struct LibraryState(pub Arc<Mutex<()>>);

pub async fn write(app: &AppHandle) -> OwnedMutexGuard<()> {
    app.state::<LibraryState>().0.clone().lock_owned().await
}

/// Maintenance must not queue behind a mutation and unexpectedly run later.
pub fn maintenance(app: &AppHandle) -> Result<OwnedMutexGuard<()>> {
    app.state::<LibraryState>()
        .0
        .clone()
        .try_lock_owned()
        .map_err(|_| {
            Error::msg(
                "The library is busy. Wait for the current operation to finish and try again.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn another_writer_and_maintenance_cannot_enter_mid_operation() {
        let state = LibraryState::default();
        let first = state.0.clone().lock_owned().await;
        assert!(state.0.clone().try_lock_owned().is_err());
        let lock = state.0.clone();
        let waiting = tokio::spawn(async move { lock.lock_owned().await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(first);
        drop(waiting.await.unwrap());
        assert!(state.0.clone().try_lock_owned().is_ok());
    }
}
