"use client";

import { useEffect, useState, useRef } from "react";

type Tag = { id: string; name: string };

export function PhotoTags({ photoId, disabled = false }: { photoId: string; disabled?: boolean }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [input, setInput] = useState("");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/photos/${photoId}/tags`)
      .then((r) => r.json())
      .then((data) => setTags(data.tags))
      .catch(() => {});
    fetch("/api/tags")
      .then((r) => r.json())
      .then((data) => setAllTags(data.tags))
      .catch(() => {});
  }, [photoId]);

  const addTag = async (name: string) => {
    if (!name.trim()) return;
    const res = await fetch(`/api/photos/${photoId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) {
      const { tag } = await res.json();
      setTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
      setAllTags((prev) =>
        prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]
      );
    }
    setInput("");
    setShowSuggestions(false);
  };

  const removeTag = async (tagId: string) => {
    const res = await fetch(`/api/photos/${photoId}/tags`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId }),
    });
    if (res.ok) {
      setTags((prev) => prev.filter((t) => t.id !== tagId));
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
            className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
          >
            {tag.name}
            {!disabled && (
              <button
                onClick={() => removeTag(tag.id)}
                className="ml-0.5 hover:text-blue-600 dark:hover:text-blue-100"
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
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-black outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        {showSuggestions && input && suggestions.length > 0 && (
          <ul className="absolute left-0 top-full z-10 mt-1 max-h-32 w-full overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
            {suggestions.slice(0, 8).map((tag) => (
              <li key={tag.id}>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addTag(tag.name)}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
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
