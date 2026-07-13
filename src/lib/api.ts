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

export function deletePhoto(id: string): Promise<void> {
  return invoke("delete_photo", { id });
}

/** Import image files (absolute paths) into a folder. Progress arrives via
 * `import://progress` events; resolves with the created catalog rows. */
export function importPhotos(paths: string[], folder: string): Promise<Photo[]> {
  return invoke("import_photos", { paths, folder });
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
};

/** Replace the local catalog with the bucket's contents. */
export function rebuildFromBucket(): Promise<RebuildReport> {
  return invoke("rebuild_from_bucket");
}
