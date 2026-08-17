import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PhotoContextMenu } from "@/components/photo-context-menu";
import { copyPhotoToClipboard, exportPhotos } from "@/lib/api";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  exportPhotos: vi.fn().mockResolvedValue(null),
  copyPhotoToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(photos = [makePhoto()], onClose = vi.fn()) {
  render(<PhotoContextMenu photos={photos} x={10} y={10} onClose={onClose} />);
  return onClose;
}

describe("PhotoContextMenu", () => {
  it("copies the filename without its extension", async () => {
    open([makePhoto({ filename: "R0012750.jpg" })]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy filename" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("R0012750"));
  });

  it("copies the name a user sees, not the stored one", async () => {
    // Legacy originals are stored as "<base>_original.<ext>"; the marker is
    // scheme plumbing and must not end up on the clipboard.
    open([makePhoto({ filename: "2025-07-01-Berlin_original.jpg" })]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy filename" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("2025-07-01-Berlin")
    );
  });

  it("copies a whole selection one name per line", async () => {
    open([
      makePhoto({ id: "1", filename: "one.jpg" }),
      makePhoto({ id: "2", filename: "two.jpg" }),
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy 2 filenames" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("one\ntwo"));
  });

  it("copies the clicked photo's pixels to the clipboard", async () => {
    open([makePhoto({ id: "abc" })]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));

    await waitFor(() => expect(copyPhotoToClipboard).toHaveBeenCalledWith("abc"));
  });

  it("leaves Copy image out for a selection", () => {
    // The system clipboard holds one image, so several photos have nothing
    // sensible to put there.
    open([makePhoto({ id: "1" }), makePhoto({ id: "2" })]);

    expect(screen.queryByRole("menuitem", { name: "Copy image" })).toBeNull();
  });

  it("reports a failed image copy instead of failing silently", async () => {
    vi.mocked(copyPhotoToClipboard).mockRejectedValueOnce(
      "Could not read this photo's images — refresh the library and try again"
    );
    open();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));

    await waitFor(() =>
      expect(message).toHaveBeenCalledWith(
        "Could not read this photo's images — refresh the library and try again",
        expect.objectContaining({ kind: "error" })
      )
    );
  });

  it("downloads the default version of the clicked photo", async () => {
    open([makePhoto({ id: "abc" })]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));

    await waitFor(() => expect(exportPhotos).toHaveBeenCalledWith(["abc"], "2880"));
  });

  it("downloads the whole selection when it opened on one", async () => {
    open([makePhoto({ id: "1" }), makePhoto({ id: "2" })]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Download 2 photos" }));

    await waitFor(() =>
      expect(exportPhotos).toHaveBeenCalledWith(["1", "2"], "2880")
    );
  });

  it("reports a failed export instead of failing silently", async () => {
    vi.mocked(exportPhotos).mockRejectedValueOnce("Bucket unreachable");
    open();

    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));

    await waitFor(() =>
      expect(message).toHaveBeenCalledWith(
        "Bucket unreachable",
        expect.objectContaining({ kind: "error" })
      )
    );
  });

  it("closes as soon as an action is picked", () => {
    const onClose = open();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy filename" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside, but not on one inside", () => {
    const onClose = open();

    fireEvent.mouseDown(screen.getByTestId("photo-context-menu"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without letting it reach the grid", () => {
    const onClose = open();
    const onDocumentEscape = vi.fn();
    document.addEventListener("keydown", onDocumentEscape);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    // The grid clears the selection on a bubble-phase Escape; the menu must
    // swallow the keypress so dismissing it doesn't also deselect.
    expect(onDocumentEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocumentEscape);
  });

  it("closes when the page scrolls out from under it", () => {
    const onClose = open();

    fireEvent.scroll(document);

    expect(onClose).toHaveBeenCalled();
  });

  it("offers Add to collection only when a caller can file the photos", () => {
    // The search results span folders, and a collection groups one folder's
    // photos — so there the item simply isn't there.
    open();
    expect(
      screen.queryByRole("menuitem", { name: /Add to collection/ })
    ).toBeNull();

    cleanup();
    const collect = vi.fn();
    const photos = [makePhoto({ id: "1" })];
    render(
      <PhotoContextMenu
        photos={photos}
        x={10}
        y={10}
        onCollect={collect}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add to collection…" })
    );
    expect(collect).toHaveBeenCalledWith(photos);
  });

  it("hands the whole right-clicked selection to the dialog", () => {
    const collect = vi.fn();
    const onClose = vi.fn();
    const photos = [makePhoto({ id: "1" }), makePhoto({ id: "2" })];
    render(
      <PhotoContextMenu
        photos={photos}
        x={10}
        y={10}
        onCollect={collect}
        onClose={onClose}
      />
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add 2 photos to a collection…" })
    );

    expect(collect).toHaveBeenCalledWith(photos);
    // The menu gets out of the way of the dialog it just opened.
    expect(onClose).toHaveBeenCalled();
  });

  it("pulls itself back inside the window when opened near an edge", () => {
    const onClose = vi.fn();
    // jsdom reports a zero-sized rect by default; give the menu a real one so
    // the clamp has something to work with.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 80,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    });
    render(
      <PhotoContextMenu
        photos={[makePhoto()]}
        x={window.innerWidth - 10}
        y={window.innerHeight - 10}
        onClose={onClose}
      />
    );

    const menu = screen.getByTestId("photo-context-menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 208}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 88}px`);
    vi.restoreAllMocks();
  });
});
