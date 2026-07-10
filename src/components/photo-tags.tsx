import { useEffect, useState, useRef } from "react";
import { addPhotoTag, getPhotoTags, listTags, removePhotoTag } from "@/lib/api";
import type { Tag } from "@/lib/types";

export function PhotoTags({ photoId, disabled = false }: { photoId: string; disabled?: boolean }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [input, setInput] = useState("");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPhotoTags(photoId)
      .then(setTags)
      .catch(() => {});
    listTags()
      .then(setAllTags)
      .catch(() => {});
  }, [photoId]);

  const addTag = async (name: string) => {
    if (!name.trim()) return;
    try {
      const tag = await addPhotoTag(photoId, name.trim());
      setTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
      setAllTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
    } catch {
      // Leave the input as typed so the user can retry
      return;
    }
    setInput("");
    setShowSuggestions(false);
  };

  const removeTag = async (tagId: string) => {
    try {
      await removePhotoTag(photoId, tagId);
      setTags((prev) => prev.filter((t) => t.id !== tagId));
    } catch {
      // Keep the tag; removal failed
    }
  };

  const suggestions = allTags.filter(
    (t) =>
      t.name.toLowerCase().includes(input.toLowerCase()) &&
      !tags.some((existing) => existing.id === t.id)
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-md bg-foreground/10 px-2 py-0.5 text-xs"
          >
            {tag.name}
            {!disabled && (
              <button
                onClick={() => removeTag(tag.id)}
                className="ml-0.5 text-foreground/50 transition-colors hover:text-foreground"
              >
                &times;
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag(input);
            }
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Add tag..."
          className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 outline-none focus:border-foreground/30"
        />
        {showSuggestions && input && suggestions.length > 0 && (
          <ul className="absolute left-0 top-full z-10 mt-1 max-h-40 w-full overflow-auto rounded-lg border border-border bg-background py-1 shadow-lg">
            {suggestions.slice(0, 8).map((tag) => (
              <li key={tag.id}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addTag(tag.name)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-foreground/5"
                >
                  {tag.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>}
    </div>
  );
}
