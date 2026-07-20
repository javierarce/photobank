import { useEffect, useMemo, useState } from "react";
import type { Photo } from "@/lib/types";
import {
  addTagsToPhotos,
  getTagsForPhotos,
  listTags,
  removeTagsFromPhotos,
} from "@/lib/api";
import { TagInput } from "@/components/tag-input";
import { ModalDialog } from "@/components/modal-dialog";

interface BulkTagDialogProps {
  photos: Photo[];
  onClose: () => void;
  /**
   * Called after tags are successfully applied. The caller owns refreshing the
   * affected views and clearing the selection; the dialog only closes when the
   * caller drops it. Fired even when nothing actually changed, so a no-op Apply
   * still dismisses cleanly.
   */
  onApplied: () => void;
}

// What the user wants to happen to an in-use tag. "keep" is the default no-op:
// for a tag on every selected photo it means leave it; for a partially-applied
// tag it means don't touch the photos either way.
type TagState = "add" | "remove" | "keep";

/**
 * The Ankitron-style bulk tag editor: add new tags to every selected photo, and
 * cycle each already-in-use tag between keep / add-to-all / remove via a
 * checklist that shows how many of the selection carry it ("X of N").
 */
export function BulkTagDialog({ photos, onClose, onApplied }: BulkTagDialogProps) {
  // New tags typed into the field, to be added to every selected photo.
  const [tags, setTags] = useState<string[]>([]);
  // Text typed into the tag field but not yet turned into a chip. Tracked so
  // clicking Apply still picks it up — pressing a button doesn't reliably blur
  // the input (and thus commit the text) on WebKit-based webviews.
  const [pending, setPending] = useState("");
  // Per in-use tag, the user's intent. Absent means "keep" (the default).
  const [tagStates, setTagStates] = useState<Map<string, TagState>>(
    () => new Map()
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  // Each selected photo's current tag names, or null until they load.
  const [photoTags, setPhotoTags] = useState<Map<string, string[]> | null>(null);

  const count = photos.length;
  // Stable identity for the selection so the fetch effect doesn't re-run every
  // render (the photos array arrives fresh from the toolbar each time).
  const ids = useMemo(() => photos.map((p) => p.id), [photos]);
  const idKey = ids.join(",");

  useEffect(() => {
    listTags()
      .then((t) => setAllTags(t.map((x) => x.name)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getTagsForPhotos(ids)
      .then((map) => {
        if (cancelled) return;
        const next = new Map<string, string[]>();
        for (const [pid, list] of Object.entries(map)) {
          next.set(
            pid,
            list.map((t) => t.name)
          );
        }
        setPhotoTags(next);
      })
      .catch(() => {
        if (!cancelled) setPhotoTags(new Map());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Tags in use across the selection, with how many of the selected photos
  // carry each one — the editable checklist.
  const usage = new Map<string, number>();
  if (photoTags) {
    for (const names of photoTags.values()) {
      for (const t of new Set(names)) usage.set(t, (usage.get(t) ?? 0) + 1);
    }
  }
  const inUse = [...usage.keys()].sort((a, b) => a.localeCompare(b));
  const hasPartial = inUse.some((t) => {
    const u = usage.get(t) ?? 0;
    return u > 0 && u < count;
  });

  // Click cycles a tag's state. A fully-applied tag toggles keep⇄remove; a
  // partially-applied one cycles keep→add→remove→keep so you can add it to the
  // rest, strip it entirely, or leave the photos as they are.
  function cycleTag(tag: string, isPartial: boolean) {
    setTagStates((prev) => {
      const next = new Map(prev);
      const cur = next.get(tag) ?? "keep";
      let resolved: TagState;
      if (isPartial) {
        resolved = cur === "keep" ? "add" : cur === "add" ? "remove" : "keep";
      } else {
        resolved = cur === "remove" ? "keep" : "remove";
      }
      if (resolved === "keep") next.delete(tag);
      else next.set(tag, resolved);
      return next;
    });
  }

  // Fold any uncommitted typed text into the new tags so it isn't lost when
  // applying without first pressing Enter.
  const pendingTag = pending.trim();
  const newTags =
    pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;

  // Resolve the full set of tags to add and to remove, merging typed-in tags
  // with checklist intent (a tag in both lands in one set, deduped).
  const adds = new Set<string>(newTags);
  const removes = new Set<string>();
  for (const [tag, state] of tagStates) {
    if (state === "add") adds.add(tag);
    else if (state === "remove") removes.add(tag);
  }
  const nothingToDo = adds.size === 0 && removes.size === 0;

  async function handleApply() {
    if (nothingToDo) {
      onClose();
      return;
    }
    const addList = [...adds];
    const removeList = [...removes];
    setBusy(true);
    setError(null);
    try {
      // The backend only adds tags a photo lacks and only strips tags it has,
      // so both are no-ops where they don't apply — no client-side dedup needed.
      if (addList.length > 0) await addTagsToPhotos(ids, addList);
      if (removeList.length > 0) await removeTagsFromPhotos(ids, removeList);
      onApplied();
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Failed to update tags"
      );
      setBusy(false);
    }
  }

  const noun = count === 1 ? "1 photo" : `${count} photos`;

  return (
    <ModalDialog
      title={`Edit Tags · ${noun}`}
      busy={busy}
      onClose={onClose}
      footer={{
        confirmLabel: "Apply",
        busyLabel: "Applying…",
        confirmDisabled: nothingToDo,
        onConfirm: handleApply,
      }}
    >
      <TagInput
        tags={tags}
        onChange={setTags}
        onInputChange={setPending}
        suggestions={allTags}
        autoFocus
        disabled={busy}
        onSubmit={() => {
          if (!nothingToDo) handleApply();
        }}
      />
      <p className="mt-2 text-xs text-foreground/50">
        Type to add new tags. Separate with commas.
      </p>

      {inUse.length > 0 && (
        <div className="mt-4">
          <ul className="max-h-64 overflow-auto rounded-lg border border-border">
            {inUse.map((tag) => {
              const used = usage.get(tag) ?? 0;
              const isPartial = used > 0 && used < count;
              const state = tagStates.get(tag) ?? "keep";
              const checked =
                state === "add" || (state === "keep" && !isPartial);
              const indeterminate = state === "keep" && isPartial;
              // Preview how many photos will carry the tag once applied.
              const projected =
                state === "remove" ? 0 : state === "add" ? count : used;
              return (
                <li key={tag}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-foreground/5">
                    <input
                      type="checkbox"
                      checked={checked}
                      ref={(el) => {
                        if (el) el.indeterminate = indeterminate;
                      }}
                      onChange={() => cycleTag(tag, isPartial)}
                      disabled={busy}
                      className="size-4 accent-accent"
                    />
                    <span
                      className={`flex-1 ${
                        state === "remove"
                          ? "text-red-500 line-through"
                          : state === "add"
                            ? "text-green-600 dark:text-green-500"
                            : ""
                      }`}
                    >
                      {tag}
                    </span>
                    <span className="text-xs tabular-nums text-foreground/40">
                      {projected} of {count}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-pretty text-xs text-foreground/50">
            {hasPartial
              ? // Non-breaking space keeps "every photo" together so "photo"
                // never orphans onto a line of its own.
                "Uncheck to remove a tag, or check a half-filled one to add it to every\u00A0photo."
              : "Uncheck the tags you want to remove."}
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </ModalDialog>
  );
}
