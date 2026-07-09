"use client";

import { useState } from "react";
import type { Photo } from "@/lib/types";

/**
 * Shared photo collection state + delete/move/rename actions, used by the
 * folder grid and the search results.
 */
export function usePhotoActions() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The photo currently open in the lightbox
  const [active, setActive] = useState<Photo | null>(null);

  const handleDelete = async (photo: Photo) => {
    if (!confirm(`Delete ${photo.filename}?`)) return;

    const res = await fetch(`/api/photos/${photo.id}`, { method: "DELETE" });
    if (res.ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setActive((prev) => (prev?.id === photo.id ? null : prev));
    } else {
      alert("Failed to delete photo");
    }
  };

  const handleMove = async (photo: Photo) => {
    const newFolder = prompt("Move to folder:", photo.folder)?.trim();
    if (!newFolder || newFolder === photo.folder) return;

    const res = await fetch(`/api/photos/${photo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: newFolder }),
    });
    if (res.ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setActive((prev) => (prev?.id === photo.id ? null : prev));
    } else {
      const body = await res.json().catch(() => null);
      alert(body?.error ?? "Failed to move photo");
    }
  };

  const handleRename = async (photo: Photo, newFilename: string) => {
    const res = await fetch(`/api/photos/${photo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: newFilename }),
    });
    if (res.ok) {
      const { photo: updated } = await res.json();
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? updated : p)));
      setActive((prev) => (prev?.id === photo.id ? updated : prev));
    } else {
      setPhotos((prev) => prev.map((p) => (p.id === photo.id ? photo : p)));
      setActive((prev) => (prev?.id === photo.id ? photo : prev));
      throw new Error("Failed to rename");
    }
  };

  return {
    photos,
    setPhotos,
    active,
    setActive,
    handleDelete,
    handleMove,
    handleRename,
  };
}
