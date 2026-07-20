import { useEffect, useState } from "react";
import { addPhotoTag, getPhotoTags, listTags, removePhotoTag } from "@/lib/api";
import { TagInput } from "@/components/tag-input";
import type { Tag } from "@/lib/types";

/**
 * The single-photo tag list shown in the lightbox. Holds the photo's tags as
 * full {id, name} rows (ids are needed to remove) and drives the shared
 * TagInput with their names, translating its add/remove edits into the
 * per-photo tag commands.
 */
export function PhotoTags({
  photoId,
  disabled = false,
}: {
  photoId: string;
  disabled?: boolean;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  useEffect(() => {
    getPhotoTags(photoId)
      .then(setTags)
      .catch(() => {});
    listTags()
      .then(setAllTags)
      .catch(() => {});
  }, [photoId]);

  const addTag = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const tag = await addPhotoTag(photoId, trimmed);
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setAllTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
    } catch {
      // Adding failed; leave the tag list as it was so the user can retry.
    }
  };

  const removeTag = async (tag: Tag) => {
    try {
      await removePhotoTag(photoId, tag.id);
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
    } catch {
      // Keep the tag; removal failed.
    }
  };

  // TagInput reports the full desired set of tag names; diff it against the
  // current rows to find the single add or remove the edit represents.
  const handleChange = (names: string[]) => {
    const current = tags.map((t) => t.name);
    for (const name of names) {
      if (!current.includes(name)) addTag(name);
    }
    for (const tag of tags) {
      if (!names.includes(tag.name)) removeTag(tag);
    }
  };

  return (
    <TagInput
      tags={tags.map((t) => t.name)}
      onChange={handleChange}
      suggestions={allTags.map((t) => t.name)}
      disabled={disabled}
      placeholder="Add tag..."
    />
  );
}
