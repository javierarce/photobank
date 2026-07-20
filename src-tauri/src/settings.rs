use std::fs;
use std::path::PathBuf;

use aws_sdk_s3::config::{Credentials, Region};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

use crate::error::{friendly_s3_error, Error, Result};

// The secret access key lives in a plain 0600 file next to settings.json,
// NOT the macOS Keychain — the Keychain surfaces a "wants to use your
// confidential information" prompt that persists even for signed, notarized
// builds. An owner-only file is the same tradeoff the AWS CLI makes for
// ~/.aws/credentials, and this IS an AWS-style credential.
const SECRET_FILE: &str = "s3-secret-access-key";

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

#[derive(Clone)]
pub struct S3Ctx {
    pub client: aws_sdk_s3::Client,
    pub bucket: String,
    /// Human-readable bucket identity — "bucket", or "bucket @ endpoint" for
    /// custom endpoints — recorded in the catalog so mutations can refuse a
    /// bucket the catalog wasn't built from.
    pub identity: String,
}

/// None until complete settings + a stored secret produce a client.
#[derive(Default)]
pub struct S3State(pub RwLock<Option<S3Ctx>>);

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir is always resolvable on macOS")
}

fn settings_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

fn secret_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join(SECRET_FILE)
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

/// Read the stored secret access key, or None if the user hasn't set one yet.
pub fn load_secret(app: &AppHandle) -> Option<String> {
    let contents = fs::read_to_string(secret_path(app)).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Persist the secret access key in an owner-only file. An empty value clears
/// it (removing the file).
fn store_secret(app: &AppHandle, secret: &str) -> Result<()> {
    let path = secret_path(app);
    let trimmed = secret.trim();

    if trimmed.is_empty() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::msg(format!("Could not clear the secret key: {e}"))),
        };
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| Error::msg(e.to_string()))?;
    }
    fs::write(&path, trimmed)
        .map_err(|e| Error::msg(format!("Could not save the secret key: {e}")))?;

    // Owner-only (0600) so other users on the machine can't read the key.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
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
        identity: bucket_identity(settings),
    }
}

/// The identity a catalog binds to (db::META_CATALOG_BUCKET): the bucket
/// name, qualified by the endpoint for S3-compatible services so two "photos"
/// buckets on different providers never look interchangeable.
pub fn bucket_identity(settings: &S3Settings) -> String {
    let bucket = settings.bucket.trim();
    match settings.custom_endpoint() {
        Some(endpoint) => format!("{bucket} @ {endpoint}"),
        None => bucket.to_string(),
    }
}

/// Guard for every operation that writes to S3 (imports, moves, deletes, the
/// manifest upload): the local catalog must belong to the configured bucket.
/// See db::ensure_catalog_bucket for the binding rules.
pub fn ensure_catalog_matches_bucket(app: &AppHandle, ctx: &S3Ctx) -> Result<()> {
    let db = app.state::<crate::db::Db>();
    let conn = db.0.lock().unwrap();
    crate::db::ensure_catalog_bucket(&conn, &ctx.identity)
}

/// Rebuild the shared client from the stored settings + secret. Runs at
/// startup and after every settings save.
pub async fn refresh_client(app: &AppHandle) {
    let settings = load_settings(app);
    let ctx = match (settings.is_complete(), load_secret(app)) {
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
    /// Bucket identity the local catalog was built from, if it's bound.
    pub catalog_bucket: Option<String>,
    /// The catalog belongs to a different bucket than the one configured —
    /// everything on screen is the old bucket's until a rebuild.
    pub bucket_mismatch: bool,
}

fn settings_info(app: &AppHandle) -> SettingsInfo {
    let settings = load_settings(app);
    let has_secret = load_secret(app).map(|s| !s.is_empty()).unwrap_or(false);
    let configured = settings.is_complete() && has_secret;
    let catalog_bucket = {
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().unwrap();
        crate::db::get_meta(&conn, crate::db::META_CATALOG_BUCKET)
            .ok()
            .flatten()
    };
    let bucket_mismatch = configured
        && catalog_bucket
            .as_deref()
            .is_some_and(|bound| bound != bucket_identity(&settings));
    SettingsInfo {
        settings,
        has_secret,
        configured,
        catalog_bucket,
        bucket_mismatch,
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
        store_secret(&app, &secret)?;
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
        .map_err(|e| Error::msg(format!("Connection failed: {}", friendly_s3_error(&e))))?;
    Ok(format!("Connected to bucket \u{201c}{}\u{201d}", ctx.bucket))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(bucket: &str, endpoint: Option<&str>) -> S3Settings {
        S3Settings {
            endpoint: endpoint.map(str::to_string),
            region: "auto".into(),
            bucket: bucket.into(),
            access_key_id: "k".into(),
        }
    }

    #[test]
    fn bucket_identity_qualifies_custom_endpoints() {
        assert_eq!(bucket_identity(&settings("photos", None)), "photos");
        assert_eq!(bucket_identity(&settings(" photos ", Some(""))), "photos");
        assert_eq!(
            bucket_identity(&settings("photos", Some("https://r2.example.com"))),
            "photos @ https://r2.example.com"
        );
    }
}
