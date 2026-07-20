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
    /// Whether the photo's derivative set exists in the bucket. Always Some
    /// when read from the catalog (NOT NULL column); None only when
    /// deserializing a manifest written before the field existed — restore
    /// falls back to `width IS NOT NULL` (locally processed rows always have
    /// their variants).
    #[serde(default)]
    pub variants_ok: Option<bool>,
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

/// Distinct EXIF values for search autocomplete. Tags and folders already have
/// their own list commands; these are the camera/lens facets. Only reflects
/// photos whose metadata has been loaded (see the lazy-metadata note).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFacets {
    pub makes: Vec<String>,
    pub models: Vec<String>,
    pub lenses: Vec<String>,
}

/// Column list matching `photo_from_row`. Keep the two in sync.
pub const PHOTO_COLUMNS: &str = "id, filename, s3_key, folder, mime_type, file_size, \
    width, height, processing_status, camera_make, camera_model, lens, focal_length, \
    aperture, shutter_speed, iso, taken_at, gps_latitude, gps_longitude, variants_ok, \
    created_at, updated_at";

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
        variants_ok: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
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

/// variants_ok: whether the photo's derivative set exists in the bucket.
/// Locally imported rows always have variants (default 1); completed rows
/// without dimensions predate this flag and came from a listing rebuild or a
/// foreign sync, where variants are unknown — start them at 0 so the refresh
/// checks them (a cheap HEAD each, not a download).
const SCHEMA_V3: &str = "
BEGIN;
ALTER TABLE photos ADD COLUMN variants_ok INTEGER NOT NULL DEFAULT 1;
UPDATE photos SET variants_ok = 0
    WHERE processing_status = 'completed' AND width IS NULL;
PRAGMA user_version = 3;
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

/// Another cataloged photo in `folder` whose filename maps to the same
/// variant stem as `filename` — "photo.jpg" vs "photo.png" vs
/// "photo_original.jpg" all derive "photo_640.webp" etc., so their
/// derivative objects would overwrite each other in the bucket. Imports
/// suffix past such names and renames refuse them.
pub fn variant_stem_occupant(
    conn: &Connection,
    folder: &str,
    filename: &str,
) -> Result<Option<String>> {
    let stem = crate::keys::variant_base(filename).to_string();
    let mut stmt = conn.prepare("SELECT id, filename FROM photos WHERE folder = ?1")?;
    let rows = stmt.query_map(rusqlite::params![folder], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, name) = row?;
        if crate::keys::variant_base(&name) == stem {
            return Ok(Some(id));
        }
    }
    Ok(None)
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
    migrate(conn)?;
    reconcile_interrupted_imports(conn)?;
    Ok(())
}

/// Import tasks live only in memory, so a process restart abandons any that were
/// in flight. A row still marked `pending`/`processing` when we open the catalog
/// is therefore a crash/force-quit leftover, not live work: flip it to `failed`.
/// This stops the grid's "still processing" poll and — crucially — lets the next
/// import of that name reclaim the row through import's failed-row retry branch.
/// Without it, `reserve_row` would treat the stuck row as a live photo and suffix
/// every retry into a fresh `(n)` duplicate while the original name stays wedged.
pub fn reconcile_interrupted_imports(conn: &Connection) -> Result<usize> {
    let swept = conn.execute(
        "UPDATE photos SET processing_status = 'failed', updated_at = ?1
         WHERE processing_status IN ('pending', 'processing')",
        rusqlite::params![now()],
    )?;
    Ok(swept)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
    }
    if version < 2 {
        conn.execute_batch(SCHEMA_V2)?;
    }
    if version < 3 {
        conn.execute_batch(SCHEMA_V3)?;
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

    fn insert_photo_with_status(conn: &Connection, id: &str, filename: &str, status: &str) {
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, processing_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'inbox', ?4, ?5, ?5)",
            params![id, filename, format!("inbox/{filename}"), status, now()],
        )
        .unwrap();
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT processing_status FROM photos WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn reconcile_marks_only_interrupted_imports_failed() {
        let conn = open_in_memory();
        insert_photo_with_status(&conn, "pend", "a.jpg", "pending");
        insert_photo_with_status(&conn, "proc", "b.jpg", "processing");
        insert_photo_with_status(&conn, "done", "c.jpg", "completed");
        insert_photo_with_status(&conn, "fail", "d.jpg", "failed");

        // A restart abandons in-flight imports, so the two unfinished rows are
        // swept to failed; finished/already-failed rows are left alone.
        let swept = reconcile_interrupted_imports(&conn).unwrap();
        assert_eq!(swept, 2);
        assert_eq!(status_of(&conn, "pend"), "failed");
        assert_eq!(status_of(&conn, "proc"), "failed");
        assert_eq!(status_of(&conn, "done"), "completed");
        assert_eq!(status_of(&conn, "fail"), "failed");
    }

    #[test]
    fn variant_stem_occupant_detects_cross_scheme_collisions() {
        let conn = open_in_memory();
        insert_photo(&conn, "legacy", "inbox", "photo_original.jpg");

        // Same stem through the legacy marker or another extension — both
        // would overwrite the legacy photo's derivative objects.
        assert_eq!(
            variant_stem_occupant(&conn, "inbox", "photo.jpg").unwrap(),
            Some("legacy".into())
        );
        assert_eq!(
            variant_stem_occupant(&conn, "inbox", "photo.png").unwrap(),
            Some("legacy".into())
        );
        // Different folder or different stem: no collision.
        assert_eq!(variant_stem_occupant(&conn, "trips", "photo.jpg").unwrap(), None);
        assert_eq!(variant_stem_occupant(&conn, "inbox", "other.jpg").unwrap(), None);
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
        assert_eq!(version, 3);
        assert_eq!(get_meta(&conn, "anything").unwrap(), None);
    }

    #[test]
    fn migrating_to_v3_marks_dimensionless_completed_rows_as_missing_variants() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute_batch(SCHEMA_V2).unwrap();
        // Locally processed row: dimensions known, variants exist.
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, width, processing_status, created_at, updated_at)
             VALUES ('local', 'a.jpg', 'inbox/a.jpg', 'inbox', 640, 'completed', ?1, ?1)",
            params![now()],
        )
        .unwrap();
        // Listing-rebuilt row: never processed here, variants unknown.
        conn.execute(
            "INSERT INTO photos (id, filename, s3_key, folder, processing_status, created_at, updated_at)
             VALUES ('foreign', 'b.jpg', 'inbox/b.jpg', 'inbox', 'completed', ?1, ?1)",
            params![now()],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let flag = |id: &str| -> bool {
            conn.query_row("SELECT variants_ok FROM photos WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert!(flag("local"));
        assert!(!flag("foreign"));
    }

    #[test]
    fn manifest_photos_without_the_variants_flag_deserialize_to_none() {
        // A manifest written before variants_ok existed must still restore.
        let json = r#"{
            "id": "p1", "filename": "a.jpg", "s3Key": "inbox/a.jpg", "folder": "inbox",
            "mimeType": null, "fileSize": null, "width": 100, "height": 50,
            "processingStatus": "completed", "cameraMake": null, "cameraModel": null,
            "lens": null, "focalLength": null, "aperture": null, "shutterSpeed": null,
            "iso": null, "takenAt": null, "gpsLatitude": null, "gpsLongitude": null,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
        }"#;
        let photo: Photo = serde_json::from_str(json).unwrap();
        assert_eq!(photo.variants_ok, None);

        let with_flag = json.replace(
            "\"createdAt\"",
            "\"variantsOk\": false, \"createdAt\"",
        );
        let photo: Photo = serde_json::from_str(&with_flag).unwrap();
        assert_eq!(photo.variants_ok, Some(false));
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
        // Fresh rows take the column default: imports always write variants.
        assert_eq!(photo.variants_ok, Some(true));
    }
}
