use std::fs;
use std::path::PathBuf;

use aws_sdk_s3::config::{Credentials, Region};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

use crate::error::{Error, Result};

const KEYRING_SERVICE: &str = "com.photobank.app";
const KEYRING_ACCOUNT: &str = "s3-secret-access-key";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct S3Settings {
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
}

impl S3Settings {
    fn custom_endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref().map(str::trim).filter(|e| !e.is_empty())
    }

    pub fn is_complete(&self) -> bool {
        !self.region.trim().is_empty()
            && !self.bucket.trim().is_empty()
            && !self.access_key_id.trim().is_empty()
    }
}

pub struct S3Ctx {
    pub client: aws_sdk_s3::Client,
    pub bucket: String,
}

/// None until complete settings + a Keychain secret produce a client.
#[derive(Default)]
pub struct S3State(pub RwLock<Option<S3Ctx>>);

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir is always resolvable on macOS")
        .join("settings.json")
}

pub fn load_settings(app: &AppHandle) -> S3Settings {
    fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn store_settings(app: &AppHandle, settings: &S3Settings) -> Result<()> {
    let path = settings_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| Error::msg(e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(settings).expect("settings always serialize");
    fs::write(&path, json).map_err(|e| Error::msg(e.to_string()))?;
    Ok(())
}

fn keyring_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| Error::msg(format!("Keychain unavailable: {e}")))
}

pub fn load_secret() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn store_secret(secret: &str) -> Result<()> {
    keyring_entry()?
        .set_password(secret)
        .map_err(|e| Error::msg(format!("Could not save the secret key in the Keychain: {e}")))
}

async fn build_ctx(settings: &S3Settings, secret: &str) -> S3Ctx {
    let credentials = Credentials::new(
        settings.access_key_id.trim(),
        secret,
        None,
        None,
        "photobank-settings",
    );
    let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(Region::new(settings.region.trim().to_string()))
        .credentials_provider(credentials);
    if let Some(endpoint) = settings.custom_endpoint() {
        loader = loader.endpoint_url(endpoint.to_string());
    }
    let sdk_config = loader.load().await;

    let mut builder = aws_sdk_s3::config::Builder::from(&sdk_config)
        // R2 and other S3-compatible services reject the SDK's newer default
        // checksums (mirrors the old src/lib/s3.ts WHEN_REQUIRED settings)
        .request_checksum_calculation(
            aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
        )
        .response_checksum_validation(
            aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
        );
    if settings.custom_endpoint().is_some() {
        builder = builder.force_path_style(true);
    }

    S3Ctx {
        client: aws_sdk_s3::Client::from_conf(builder.build()),
        bucket: settings.bucket.trim().to_string(),
    }
}

/// Rebuild the shared client from disk + Keychain. Runs at startup and after
/// every settings save.
pub async fn refresh_client(app: &AppHandle) {
    let settings = load_settings(app);
    let ctx = match (settings.is_complete(), load_secret()) {
        (true, Some(secret)) if !secret.is_empty() => Some(build_ctx(&settings, &secret).await),
        _ => None,
    };
    *app.state::<S3State>().0.write().await = ctx;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInfo {
    pub settings: S3Settings,
    pub has_secret: bool,
    pub configured: bool,
}

fn settings_info(app: &AppHandle) -> SettingsInfo {
    let settings = load_settings(app);
    let has_secret = load_secret().map(|s| !s.is_empty()).unwrap_or(false);
    let configured = settings.is_complete() && has_secret;
    SettingsInfo {
        settings,
        has_secret,
        configured,
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsInfo {
    settings_info(&app)
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    settings: S3Settings,
    secret_access_key: Option<String>,
) -> Result<SettingsInfo> {
    store_settings(&app, &settings)?;
    if let Some(secret) = secret_access_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    {
        store_secret(&secret)?;
    }
    refresh_client(&app).await;
    Ok(settings_info(&app))
}

#[tauri::command]
pub async fn test_connection(app: AppHandle) -> Result<String> {
    let state = app.state::<S3State>();
    let guard = state.0.read().await;
    let ctx = guard.as_ref().ok_or_else(|| {
        Error::msg("S3 is not configured yet — fill in every field and save first")
    })?;
    ctx.client
        .list_objects_v2()
        .bucket(&ctx.bucket)
        .max_keys(1)
        .send()
        .await
        .map_err(|e| {
            Error::msg(format!(
                "Connection failed: {}",
                aws_smithy_types::error::display::DisplayErrorContext(&e)
            ))
        })?;
    Ok(format!("Connected to bucket \u{201c}{}\u{201d}", ctx.bucket))
}
