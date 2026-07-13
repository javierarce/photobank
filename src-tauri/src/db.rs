use std::fs;
use std::sync::Mutex;

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// The catalog connection, managed as Tauri state. Access is coarse-grained —
/// a single mutex is plenty for a single-user catalog.
pub struct Db(pub Mutex<Connection>);

/// Mirrors src/lib/types.ts `Photo`. Timestamps are RFC 3339 strings so they
/// cross the IPC boundary exactly like the old JSON API responses did.
/// Deserialize is for reading the bucket manifest back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: String,
    pub filename: String,
    pub s3_key: String,
    pub folder: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub processing_status: String,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens: Option<String>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<i64>,
    pub taken_at: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderCount {
    pub folder: String,
    pub count: i64,
}

/// Column list matching `photo_from_row`. Keep the two in sync.
pub const PHOTO_COLUMNS: &str = "id, filename, s3_key, folder, mime_type, file_size, \
    width, height, processing_status, camera_make, camera_model, lens, focal_length, \
    aperture, shutter_speed, iso, taken_at, gps_latitude, gps_longitude, created_at, updated_at";

pub fn photo_from_row(row: &Row) -> rusqlite::Result<Photo> {
    Ok(Photo {
        id: row.get(0)?,
        filename: row.get(1)?,
        s3_key: row.get(2)?,
        folder: row.get(3)?,
        mime_type: row.get(4)?,
        file_size: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        processing_status: row.get(8)?,
        camera_make: row.get(9)?,
        camera_model: row.get(10)?,
        lens: row.get(11)?,
        focal_length: row.get(12)?,
        aperture: row.get(13)?,
        shutter_speed: row.get(14)?,
        iso: row.get(15)?,
        taken_at: row.get(16)?,
        gps_latitude: row.get(17)?,
        gps_longitude: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

const SCHEMA_V1: &str = "
BEGIN;
CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'inbox',
    mime_type TEXT,
    file_size INTEGER,
    width INTEGER,
    height INTEGER,
    processing_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
    camera_make TEXT,
    camera_model TEXT,
    lens TEXT,
    focal_length TEXT,
    aperture TEXT,
    shutter_speed TEXT,
    iso INTEGER,
    taken_at TEXT,
    gps_latitude REAL,
    gps_longitude REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX photos_folder_filename_idx ON photos (folder, filename);
CREATE INDEX photos_folder_idx ON photos (folder);
CREATE INDEX photos_created_at_idx ON photos (created_at);
CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE photo_tags (
    photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, tag_id)
);
PRAGMA user_version = 1;
COMMIT;
";

const SCHEMA_V2: &str = "
BEGIN;
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
PRAGMA user_version = 2;
COMMIT;
";

/// meta key: the bucket identity this catalog was built from.
pub const META_CATALOG_BUCKET: &str = "catalog_bucket";

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    match conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    ) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// Every S3 write must target the bucket this catalog was built from —
/// otherwise a stale catalog (e.g. after switching Settings from a test
/// bucket to a production one) could delete or overwrite objects it never
/// cataloged. An empty catalog binds to the configured bucket on first use;
/// anything else re-binds only through "Rebuild from bucket".
pub fn ensure_catalog_bucket(conn: &Connection, bucket: &str) -> Result<()> {
    if let Some(bound) = get_meta(conn, META_CATALOG_BUCKET)? {
        if bound == bucket {
            return Ok(());
        }
        return Err(Error::msg(format!(
            "This catalog was built from \u{201c}{bound}\u{201d} but the app is now configured \
             for \u{201c}{bucket}\u{201d}. Run \u{201c}Rebuild from bucket\u{201d} in Settings \
             before making changes."
        )));
    }

    let photos: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |row| row.get(0))?;
    if photos > 0 {
        return Err(Error::msg(format!(
            "This catalog isn't linked to a bucket yet. Run \u{201c}Rebuild from bucket\u{201d} \
             in Settings to link it to \u{201c}{bucket}\u{201d}."
        )));
    }
    set_meta(conn, META_CATALOG_BUCKET, bucket)
}

/// Open (creating if needed) the catalog at
/// `~/Library/Application Support/com.photobank.app/photobank.db`.
pub fn init(app: &AppHandle) -> Result<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app data dir is always resolvable on macOS");
    fs::create_dir_all(&dir).map_err(|e| crate::error::Error::msg(e.to_string()))?;
    open(&dir.join("photobank.db"))
}

/// Open a catalog database at an explicit path. Used by `init` and by tests.
pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
    }
    if version < 2 {
        conn.execute_batch(SCHEMA_V2)?;
    }
    Ok(())
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
pub fn open_in_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    // WAL doesn't apply to in-memory databases; run the rest of the setup.
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn insert_photo(conn: &Connection, id: &str, folder: &str, filename: &str) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, filename, format!("{folder}/{filename}"), folder, now()],
        )
        .unwrap();
    }

    #[test]
    fn folder_and_filename_are_unique_together() {
        let conn = open_in_memory();
        insert_photo(&conn, "a", "inbox", "photo.jpg");
        // Same filename in another folder is fine
        insert_photo(&conn, "b", "trips", "photo.jpg");
        // Duplicate within the folder violates the unique index
        let dup = conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, created_at, updated_at)
             VALUES ('c', 'photo.jpg', 'inbox/photo.jpg', 'inbox', '2026-01-01', '2026-01-01')",
            [],
        );
        assert!(dup.is_err());
    }

    #[test]
    fn deleting_a_photo_cascades_to_photo_tags() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1", "inbox", "photo.jpg");
        conn.execute(
            "INSERT INTO tags (id, name, created_at) VALUES ('t1', 'sunset', ?1)",
            params![now()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_tags (photo_id, tag_id) VALUES ('p1', 't1')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM photos WHERE id = 'p1'", []).unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM photo_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn migrating_a_v1_catalog_adds_the_meta_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(get_meta(&conn, "anything").unwrap(), None);
    }

    #[test]
    fn meta_values_roundtrip_and_overwrite() {
        let conn = open_in_memory();
        assert_eq!(get_meta(&conn, "k").unwrap(), None);
        set_meta(&conn, "k", "one").unwrap();
        assert_eq!(get_meta(&conn, "k").unwrap(), Some("one".into()));
        set_meta(&conn, "k", "two").unwrap();
        assert_eq!(get_meta(&conn, "k").unwrap(), Some("two".into()));
    }

    #[test]
    fn empty_catalog_binds_to_the_first_bucket_it_sees() {
        let conn = open_in_memory();
        ensure_catalog_bucket(&conn, "prod").unwrap();
        assert_eq!(
            get_meta(&conn, META_CATALOG_BUCKET).unwrap(),
            Some("prod".into())
        );
        // Bound: the same bucket keeps working, another one is refused
        ensure_catalog_bucket(&conn, "prod").unwrap();
        let err = ensure_catalog_bucket(&conn, "other").unwrap_err();
        assert!(err.to_string().contains("Rebuild from bucket"), "{err}");
        assert!(err.to_string().contains("prod"), "{err}");
    }

    #[test]
    fn unbound_catalog_with_photos_requires_a_rebuild() {
        let conn = open_in_memory();
        insert_photo(&conn, "a", "inbox", "photo.jpg");
        let err = ensure_catalog_bucket(&conn, "prod").unwrap_err();
        assert!(err.to_string().contains("Rebuild from bucket"), "{err}");
        // The failed check must not have bound anything
        assert_eq!(get_meta(&conn, META_CATALOG_BUCKET).unwrap(), None);
    }

    #[test]
    fn photo_row_roundtrips_through_photo_from_row() {
        let conn = open_in_memory();
        insert_photo(&conn, "p1", "inbox", "photo.jpg");

        let photo = conn
            .query_row(
                &format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id = 'p1'"),
                [],
                photo_from_row,
            )
            .unwrap();

        assert_eq!(photo.id, "p1");
        assert_eq!(photo.s3_key, "inbox/photo.jpg");
        assert_eq!(photo.processing_status, "pending");
        assert_eq!(photo.width, None);
    }
}
