import { invoke } from "@tauri-apps/api/core";
import type { FolderCount, Photo, Tag } from "@/lib/types";

/**
 * Thin typed layer over the Tauri commands implemented in
 * `src-tauri/src/commands.rs`. Commands reject with a plain error-message
 * string, which callers surface as-is.
 */

export function listFolders(): Promise<FolderCount[]> {
  return invoke("list_folders");
}

export function listPhotos(folder: string): Promise<Photo[]> {
  return invoke("list_photos", { folder });
}

export function searchPhotos(params: {
  q?: string;
  tag?: string;
  camera?: string;
}): Promise<Photo[]> {
  return invoke("search_photos", {
    q: params.q || null,
    tag: params.tag || null,
    camera: params.camera || null,
  });
}

export function listTags(): Promise<Tag[]> {
  return invoke("list_tags");
}

export function getPhotoTags(photoId: string): Promise<Tag[]> {
  return invoke("get_photo_tags", { photoId });
}

export function addPhotoTag(photoId: string, name: string): Promise<Tag> {
  return invoke("add_photo_tag", { photoId, name });
}

export function removePhotoTag(photoId: string, tagId: string): Promise<void> {
  return invoke("remove_photo_tag", { photoId, tagId });
}

/** Move (new folder) and/or rename (new filename) a photo. */
export function updatePhoto(
  id: string,
  changes: { folder?: string; filename?: string }
): Promise<Photo> {
  return invoke("update_photo", {
    id,
    folder: changes.folder ?? null,
    filename: changes.filename ?? null,
  });
}

/** Rename a folder, re-keying every photo it contains. Rejects if the target
 * name is taken or invalid; "inbox" can't be renamed. Resolves with the
 * number of photos moved. */
export function renameFolder(
  oldName: string,
  newName: string
): Promise<number> {
  return invoke("rename_folder", { oldName, newName });
}

export function deletePhoto(id: string): Promise<void> {
  return invoke("delete_photo", { id });
}

/** Import image files (absolute paths) into a folder. Progress arrives via
 * `import://progress` events; resolves with the created catalog rows. */
export function importPhotos(paths: string[], folder: string): Promise<Photo[]> {
  return invoke("import_photos", { paths, folder });
}

/** Ask the importer to cancel an in-flight or queued upload by its
 * "folder/filename" key. Resolves immediately; the import stops at its next
 * checkpoint and confirms with a `cancelled` progress event. */
export function cancelImport(key: string): Promise<void> {
  return invoke("cancel_import", { key });
}

/** Which stored version of a photo to export. */
export type ExportResolution = "640" | "1280" | "2880" | "original";

/** Export photos as files into a directory picked by the user. */
export function exportPhotos(
  photoIds: string[],
  resolution: ExportResolution = "2880"
): Promise<string | null> {
  return invoke("export_photos", { photoIds, resolution });
}

export type S3Settings = {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
};

export type SettingsInfo = {
  settings: S3Settings;
  /** A secret access key is stored in the macOS Keychain. */
  hasSecret: boolean;
  /** Settings + secret are complete; the S3 client is usable. */
  configured: boolean;
  /** Bucket identity the local catalog was built from, if it's bound. */
  catalogBucket: string | null;
  /** The catalog belongs to a different bucket than the one configured —
   * everything on screen is the old bucket's until a rebuild. */
  bucketMismatch: boolean;
};

export function getSettings(): Promise<SettingsInfo> {
  return invoke("get_settings");
}

/** Pass secretAccessKey only when the user typed a new one; null keeps the
 * Keychain entry untouched. */
export function saveSettings(
  settings: S3Settings,
  secretAccessKey: string | null
): Promise<SettingsInfo> {
  return invoke("save_settings", { settings, secretAccessKey });
}

/** Resolves with a human-readable success message, rejects with the error. */
export function testConnection(): Promise<string> {
  return invoke("test_connection");
}

export type RebuildReport = {
  photos: number;
  tags: number;
  /** "manifest" (full metadata) or "listing" (bucket scan fallback). */
  source: "manifest" | "listing";
  /** Photos missing their thumbnail set; a background refresh has started. */
  needsRefresh: number;
};

/** Replace the local catalog with the bucket's contents. */
export function rebuildFromBucket(): Promise<RebuildReport> {
  return invoke("rebuild_from_bucket");
}

/** Emitted per listing page while a rebuild scans the bucket. */
export type RebuildProgress = {
  /** Objects (originals + variants) listed so far. */
  scanned: number;
};

export const REBUILD_PROGRESS_EVENT = "rebuild://progress";

/** Emitted once per refreshed photo, plus a final "done"/"cancelled" event. */
export type RefreshProgress = {
  total: number;
  done: number;
  failed: number;
  status: "running" | "done" | "cancelled";
  photoId: string | null;
  filename: string | null;
  error: string | null;
};

export const REFRESH_PROGRESS_EVENT = "refresh://progress";

export type RefreshReport = {
  total: number;
  refreshed: number;
  failed: number;
  cancelled: boolean;
};

/** Photos that a refresh would check for a missing thumbnail set. */
export function refreshPendingCount(): Promise<number> {
  return invoke("refresh_pending_count");
}

/** Progress of the refresh currently running in the background, or null when
 * idle. Lets a freshly mounted page rejoin a run started elsewhere. */
export function refreshStatus(): Promise<RefreshProgress | null> {
  return invoke("refresh_status");
}

/** Regenerate variants and metadata for every photo that needs it. Progress
 * arrives via `refresh://progress` events; resolves when the run settles. */
export function refreshLibrary(): Promise<RefreshReport> {
  return invoke("refresh_library");
}

/** Ask the running refresh to stop at the next photo boundary. */
export function cancelRefresh(): Promise<void> {
  return invoke("cancel_refresh");
}

/** Download one photo's original and fill in its EXIF and dimensions.
 * Resolves with the updated catalog row. */
export function loadPhotoMetadata(photoId: string): Promise<Photo> {
  return invoke("load_photo_metadata", { photoId });
}
