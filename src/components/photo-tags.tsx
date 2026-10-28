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
type Props = { photoId: string; disabled?: boolean; onTagsChange?: () => void };

export function PhotoTags(props: Props) {
  return <PhotoTagEditor key={props.photoId} {...props} />;
}

function PhotoTagEditor({ photoId, disabled = false, onTagsChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  useEffect(() => {
    let current = true;
    getPhotoTags(photoId)
      .then((tags) => { if (current) { setTags(tags); setLoaded(true); } })
      .catch(() => { if (current) setError("Could not load tags. Reopen this photo to retry."); });
    listTags()
      .then((loaded) => { if (current) setAllTags(loaded); })
      .catch(() => {});
    return () => { current = false; };
  }, [photoId]);

  const addTag = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const tag = await addPhotoTag(photoId, trimmed);
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setAllTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
      onTagsChange?.();
    } catch {
      setError("Could not add the tag. Try again.");
    }
  };

  const removeTag = async (tag: Tag) => {
    setError(null);
    try {
      await removePhotoTag(photoId, tag.id);
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      onTagsChange?.();
    } catch {
      setError("Could not remove the tag. Try again.");
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
    <>
    <TagInput
      tags={tags.map((t) => t.name)}
      onChange={handleChange}
      suggestions={allTags.map((t) => t.name)}
      disabled={disabled || !loaded}
      placeholder="Add tag..."
    />
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </>
  );
}
