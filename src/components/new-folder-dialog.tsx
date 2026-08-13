import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { useUpload } from "@/hooks/use-upload";
import { previewUrl } from "@/lib/image-url";

/** The name as it will be stored: a slash would fracture the folder/filename
 * key scheme, so fold it (and any run of whitespace) away. */
function normalizeFolderName(value: string): string {
  return value.trim().replace(/\/+/g, " ").replace(/\s+/g, " ").trim();
}

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

type Props = {
  /** The folder names already in the listing, so an existing folder is opened
   * rather than shadowed by a case-variant sibling. */
  existing: string[];
  /** Called with the resolved folder name and the photos to upload into it. */
  onCreate: (folder: string, paths: string[]) => void;
  onClose: () => void;
};

/**
 * Names a new folder, optionally with its first photos. A folder is just the
 * `folder` field on its photos — there's no empty-folder record to create — so
 * the dialog either drops the user on the (empty) folder page or seeds it with
 * a drop, which materializes it for real.
 *
 * Files dropped here are staged, not imported: the destination doesn't exist
 * until Create, so the drop is diverted to this dialog through the upload
 * provider's drop sink (native drags never reach the DOM in WKWebView).
 */
export function NewFolderDialog({ existing, onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const { overDropSink, registerDropSink, pickImages } = useUpload();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Take over file drops for as long as the dialog is open. Re-dropping a file
  // that's already staged is a no-op rather than a duplicate tile.
  useEffect(() => {
    return registerDropSink((dropped) => {
      setPaths((prev) => [...prev, ...dropped.filter((p) => !prev.includes(p))]);
    });
  }, [registerDropSink]);

  const folder = normalizeFolderName(name);
  // Reuse the exact casing of an existing folder so we open it rather than
  // spawn a case-variant sibling.
  const match = existing.find((f) => f.toLowerCase() === folder.toLowerCase());

  const create = () => {
    if (!folder) return;
    onCreate(match ?? folder, paths);
  };

  const choose = async () => {
    const picked = await pickImages();
    setPaths((prev) => [...prev, ...picked.filter((p) => !prev.includes(p))]);
  };

  return (
    <ModalDialog
      title="New folder"
      // Photos can be dropped anywhere on the card, not just on the box below.
      dropSink
      onClose={onClose}
      footer={{
        confirmLabel: paths.length
          ? `Create and upload ${paths.length}`
          : "Create",
        confirmDisabled: !folder,
        onConfirm: create,
      }}
    >
      <div className="flex flex-col gap-3">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          // Nothing is swallowed here: Escape has to reach ModalDialog's
          // document listener to close the dialog, and the grid cursor already
          // ignores keys typed into an input.
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="Folder name"
          aria-label="Folder name"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/40 focus:border-foreground/30"
          data-testid="new-folder-input"
        />
        {match && match !== folder && (
          <p className="text-xs text-foreground/50">
            Opens the existing folder{" "}
            <span className="font-medium text-foreground/70">{match}</span>.
          </p>
        )}

        <div
          className={`flex flex-col gap-3 rounded-md border border-dashed p-3 transition-colors ${
            overDropSink ? "border-accent bg-accent/5" : "border-border"
          }`}
          data-testid="new-folder-dropzone"
        >
          {paths.length > 0 && (
            // Fixed square tracks rather than aspect-ratio tiles: the row
            // height can't then depend on the (absolutely positioned) contents,
            // so a big drop stacks into real rows and scrolls instead of
            // collapsing on top of itself.
            <ul
              className="grid max-h-64 auto-rows-[72px] grid-cols-[repeat(auto-fill,72px)] justify-between gap-2 overflow-y-auto"
              data-testid="new-folder-staged"
            >
              {paths.map((path) => (
                <StagedPhoto
                  key={path}
                  path={path}
                  onRemove={() =>
                    setPaths((prev) => prev.filter((p) => p !== path))
                  }
                />
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground/50">
              {paths.length
                ? `${paths.length} photo${paths.length > 1 ? "s" : ""} to upload`
                : "Drag photos here to upload them into the folder"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {/* Dropping the wrong folder in is one mistake; taking it back
                  out a tile at a time would be eighty. */}
              {paths.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPaths([])}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
                  data-testid="new-folder-clear"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={choose}
                className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/70 transition hover:border-foreground/35 hover:text-foreground active:scale-[0.97]"
                data-testid="new-folder-choose"
              >
                Choose photos…
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

/** One staged file: its pixels read straight off disk through `preview://`,
 * with the filename showing through until they load (never the webview's
 * broken-image glyph). */
function StagedPhoto({
  path,
  onRemove,
}: {
  path: string;
  onRemove: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const filename = basename(path);

  return (
    <li className="relative h-[72px] w-[72px] overflow-hidden rounded bg-foreground/5">
      <span className="absolute inset-0 flex items-center justify-center p-1 text-center font-mono text-[10px] leading-tight text-foreground/40">
        <span className="line-clamp-2 break-all">{filename}</span>
      </span>
      <img
        src={previewUrl(path)}
        alt={filename}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        draggable={false}
        decoding="async"
        // `preview://` serves the whole original, so an 80-photo drop would
        // otherwise read (and decode) hundreds of megabytes at once for tiles
        // that are scrolled out of sight.
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${filename}`}
        // Always visible, not hover-revealed: a staged photo you can't see how
        // to drop is a photo you have to cancel the whole dialog to be rid of.
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-xs text-foreground/60 transition hover:text-foreground"
      >
        ×
      </button>
    </li>
  );
}
