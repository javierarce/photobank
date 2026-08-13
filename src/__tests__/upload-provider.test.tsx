import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import { UploadProvider } from "@/hooks/upload-provider";
import { useUpload } from "@/hooks/use-upload";
import {
  cancelImport,
  checkImportCollisions,
  importPhotos,
  replacePhotos,
  setUploadBadge,
} from "@/lib/api";

// Capture the import://progress listener so tests can emit events, and stub the
// native drag-drop subscription the provider also registers.
const hoisted = vi.hoisted(() => ({
  progress: null as null | ((event: { payload: unknown }) => void),
  dragDrop: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (event: { payload: unknown }) => void) => {
    hoisted.progress = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (event: { payload: unknown }) => void) => {
      hoisted.dragDrop = cb;
      return Promise.resolve(() => {});
    },
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  importPhotos: vi.fn(),
  replacePhotos: vi.fn(),
  checkImportCollisions: vi.fn(),
  cancelImport: vi.fn(),
  setUploadBadge: vi.fn(),
}));

const mockImportPhotos = vi.mocked(importPhotos);
const mockReplacePhotos = vi.mocked(replacePhotos);
const mockCheckCollisions = vi.mocked(checkImportCollisions);
const mockCancelImport = vi.mocked(cancelImport);
const mockSetUploadBadge = vi.mocked(setUploadBadge);

// A tiny consumer that renders each upload's status and a cancel button, plus a
// trigger to seed an upload through the file picker (which drives handlePaths).
function Consumer() {
  const { files, summarize, openFilePicker, cancelUpload, removeUpload } =
    useUpload();
  const batch = summarize("vacation");
  return (
    <div>
      <button onClick={() => openFilePicker("vacation")}>pick</button>
      <span data-testid="summary">
        {batch.completed}/{batch.total} · {batch.percent}%
      </span>
      <ul>
        {files.map((f) => (
          <li key={f.key}>
            <span data-testid={`status-${f.filename}`}>{f.status}</span>
            <button onClick={() => cancelUpload(f.key)}>cancel-{f.filename}</button>
            {/* Stands in for the grid dismissing a tile once its thumbnail lands */}
            <button onClick={() => removeUpload(f.key)}>dismiss-{f.filename}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function emit(payload: Record<string, unknown>) {
  act(() => {
    hoisted.progress?.({ payload });
  });
}

function progressEvent(status: string, progress = 20) {
  return {
    key: "vacation/beach.jpg",
    photoId: "p1",
    filename: "beach.jpg",
    folder: "vacation",
    progress,
    status,
    error: null,
  };
}

// Seed a single pending upload for vacation/beach.jpg.
async function seedUpload() {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.open).mockResolvedValueOnce(["/tmp/beach.jpg"]);
  mockImportPhotos.mockResolvedValueOnce([]);

  render(
    <UploadProvider>
      <Consumer />
    </UploadProvider>
  );
  fireEvent.click(screen.getByText("pick"));
  await waitFor(() =>
    expect(screen.getByTestId("status-beach.jpg")).toHaveTextContent("pending")
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.progress = null;
  hoisted.dragDrop = null;
  // invoke() always returns a promise; the mock must too, so the provider's
  // `.catch` has something to attach to.
  mockCancelImport.mockResolvedValue(undefined);
  // Default: nothing in the folder clashes, so drops go straight through
  // without the collision dialog.
  mockCheckCollisions.mockResolvedValue([]);
  mockImportPhotos.mockResolvedValue([]);
  mockReplacePhotos.mockResolvedValue([]);
  mockSetUploadBadge.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("UploadProvider cancellation", () => {
  it("marks the tile cancelling and calls cancel_import with its key", async () => {
    await seedUpload();
    emit(progressEvent("uploading"));
    expect(screen.getByTestId("status-beach.jpg")).toHaveTextContent("uploading");

    fireEvent.click(screen.getByText("cancel-beach.jpg"));

    expect(screen.getByTestId("status-beach.jpg")).toHaveTextContent("cancelling");
    expect(mockCancelImport).toHaveBeenCalledWith("vacation/beach.jpg");
  });

  it("ignores in-flight progress while cancelling but removes the tile on cancelled", async () => {
    await seedUpload();
    emit(progressEvent("uploading"));
    fireEvent.click(screen.getByText("cancel-beach.jpg"));

    // A late progress tick must not pull the tile back to uploading.
    emit(progressEvent("uploading", 60));
    expect(screen.getByTestId("status-beach.jpg")).toHaveTextContent("cancelling");

    // The importer confirms cancellation — the tile disappears.
    emit(progressEvent("cancelled", 100));
    expect(screen.queryByTestId("status-beach.jpg")).not.toBeInTheDocument();
  });

  it("lets a terminal done win when the cancel lost the race", async () => {
    await seedUpload();
    fireEvent.click(screen.getByText("cancel-beach.jpg"));

    // The upload actually finished before the cancel landed.
    emit(progressEvent("done", 100));
    expect(screen.getByTestId("status-beach.jpg")).toHaveTextContent("done");
  });
});

// Drop two files into "vacation" and settle the collision check.
async function dropTwo(collisions: string[]) {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.open).mockResolvedValueOnce([
    "/tmp/beach.jpg",
    "/tmp/sunset.jpg",
  ]);
  mockCheckCollisions.mockResolvedValueOnce(collisions);

  render(
    <UploadProvider>
      <Consumer />
    </UploadProvider>
  );
  fireEvent.click(screen.getByText("pick"));
}

describe("UploadProvider name collisions", () => {
  it("imports straight through when nothing clashes", async () => {
    await dropTwo([]);

    await waitFor(() =>
      expect(mockImportPhotos).toHaveBeenCalledWith(
        ["/tmp/beach.jpg", "/tmp/sunset.jpg"],
        "vacation"
      )
    );
    // No question to ask, so no dialog and nothing overwritten.
    expect(screen.queryByTestId("collision-list")).not.toBeInTheDocument();
    expect(mockReplacePhotos).not.toHaveBeenCalled();
  });

  it("asks before suffixing a name that's already taken", async () => {
    await dropTwo(["beach.jpg"]);

    await waitFor(() =>
      expect(screen.getByTestId("collision-list")).toHaveTextContent("beach.jpg")
    );
    // Nothing is uploaded until the user answers — the whole point.
    expect(mockImportPhotos).not.toHaveBeenCalled();
    expect(mockReplacePhotos).not.toHaveBeenCalled();
  });

  it("splits the batch when the user picks Replace", async () => {
    await dropTwo(["beach.jpg"]);
    await waitFor(() => screen.getByTestId("collision-replace"));

    fireEvent.click(screen.getByTestId("collision-replace"));

    // The clashing file overwrites in place; the fresh one imports normally.
    await waitFor(() =>
      expect(mockReplacePhotos).toHaveBeenCalledWith(["/tmp/beach.jpg"], "vacation")
    );
    expect(mockImportPhotos).toHaveBeenCalledWith(["/tmp/sunset.jpg"], "vacation");
    // Both kinds of work get a tile, since both stream the same progress events.
    expect(screen.getByTestId("status-beach.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("status-sunset.jpg")).toBeInTheDocument();
  });

  it("sends everything to the importer when the user picks Keep both", async () => {
    await dropTwo(["beach.jpg"]);
    await waitFor(() => screen.getByTestId("collision-keep-both"));

    fireEvent.click(screen.getByTestId("collision-keep-both"));

    // Suffixing is the importer's own behaviour, so the batch stays whole.
    await waitFor(() =>
      expect(mockImportPhotos).toHaveBeenCalledWith(
        ["/tmp/beach.jpg", "/tmp/sunset.jpg"],
        "vacation"
      )
    );
    expect(mockReplacePhotos).not.toHaveBeenCalled();
  });

  it("drops only the clashing files when the user picks Skip", async () => {
    await dropTwo(["beach.jpg"]);
    await waitFor(() => screen.getByTestId("collision-skip"));

    fireEvent.click(screen.getByTestId("collision-skip"));

    await waitFor(() =>
      expect(mockImportPhotos).toHaveBeenCalledWith(["/tmp/sunset.jpg"], "vacation")
    );
    expect(mockReplacePhotos).not.toHaveBeenCalled();
    // The skipped file never gets a tile — nothing happened to it.
    expect(screen.queryByTestId("status-beach.jpg")).not.toBeInTheDocument();
  });

  it("abandons the whole drop when the dialog is dismissed", async () => {
    await dropTwo(["beach.jpg"]);
    await waitFor(() => screen.getByTestId("collision-replace"));

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByTestId("collision-list")).not.toBeInTheDocument()
    );
    // Escape means "I didn't mean to do that" — not "import the rest".
    expect(mockImportPhotos).not.toHaveBeenCalled();
    expect(mockReplacePhotos).not.toHaveBeenCalled();
  });

  it("falls back to the old suffixing behaviour if the check fails", async () => {
    const dialog = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialog.open).mockResolvedValueOnce(["/tmp/beach.jpg"]);
    mockCheckCollisions.mockRejectedValueOnce("catalog unavailable");

    render(
      <UploadProvider>
        <Consumer />
      </UploadProvider>
    );
    fireEvent.click(screen.getByText("pick"));

    // A broken check must not block uploading altogether.
    await waitFor(() =>
      expect(mockImportPhotos).toHaveBeenCalledWith(["/tmp/beach.jpg"], "vacation")
    );
    expect(screen.queryByTestId("collision-list")).not.toBeInTheDocument();
  });
});

function fileEvent(
  filename: string,
  status: string,
  progress: number
) {
  return {
    key: `vacation/${filename}`,
    photoId: filename,
    filename,
    folder: "vacation",
    progress,
    status,
    error: null,
  };
}

describe("UploadProvider batch progress", () => {
  it("averages the drop into one percentage", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));

    emit(fileEvent("beach.jpg", "done", 100));
    emit(fileEvent("sunset.jpg", "uploading", 50));

    expect(screen.getByTestId("summary")).toHaveTextContent("1/2 · 75%");
  });

  it("keeps a dismissed upload in the total so the percentage never drops", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    emit(fileEvent("beach.jpg", "done", 100));
    emit(fileEvent("sunset.jpg", "uploading", 50));

    // The grid dismisses the finished tile mid-batch, once its thumbnail lands.
    fireEvent.click(screen.getByText("dismiss-beach.jpg"));

    expect(screen.queryByTestId("status-beach.jpg")).not.toBeInTheDocument();
    expect(screen.getByTestId("summary")).toHaveTextContent("1/2 · 75%");
  });

  it("forgets the tally once the batch is over", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    emit(fileEvent("beach.jpg", "done", 100));
    emit(fileEvent("sunset.jpg", "done", 100));

    fireEvent.click(screen.getByText("dismiss-beach.jpg"));
    fireEvent.click(screen.getByText("dismiss-sunset.jpg"));

    // Nothing left to report — the next drop starts from zero, not 2/2.
    await waitFor(() =>
      expect(screen.getByTestId("summary")).toHaveTextContent("0/0 · 0%")
    );
  });

  it("does not let an undismissed failure carry a tally into the next drop", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    emit(fileEvent("beach.jpg", "done", 100));
    emit(fileEvent("sunset.jpg", "error", 40));
    fireEvent.click(screen.getByText("dismiss-beach.jpg"));

    // The failed tile is still on screen, but it's outside the ratio — so the
    // batch is over and there's nothing left to report.
    expect(screen.getByTestId("status-sunset.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("summary")).toHaveTextContent("0/0 · 0%");

    // A fresh drop alongside that lingering failure starts from zero rather
    // than inheriting the finished batch's one completed file.
    const dialog = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialog.open).mockResolvedValueOnce(["/tmp/dune.jpg"]);
    fireEvent.click(screen.getByText("pick"));
    await waitFor(() => screen.getByTestId("status-dune.jpg"));

    emit(fileEvent("dune.jpg", "uploading", 50));
    expect(screen.getByTestId("summary")).toHaveTextContent("0/1 · 50%");
  });

  it("leaves a cancelled upload out of the total", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    emit(fileEvent("beach.jpg", "cancelled", 30));
    emit(fileEvent("sunset.jpg", "uploading", 60));

    // A cancelled file was never part of the batch's work.
    expect(screen.getByTestId("summary")).toHaveTextContent("0/1 · 60%");
  });
});

describe("UploadProvider dock badge", () => {
  it("shows the overall percentage on the app icon while importing", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));

    emit(fileEvent("beach.jpg", "uploading", 80));
    emit(fileEvent("sunset.jpg", "uploading", 20));

    await waitFor(() => expect(mockSetUploadBadge).toHaveBeenLastCalledWith(50));
  });

  it("clears the badge once nothing is uploading", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    emit(fileEvent("beach.jpg", "uploading", 80));

    emit(fileEvent("beach.jpg", "done", 100));
    emit(fileEvent("sunset.jpg", "done", 100));

    await waitFor(() => expect(mockSetUploadBadge).toHaveBeenLastCalledWith(null));
  });

  it("does not re-badge on every progress tick", async () => {
    await dropTwo([]);
    await waitFor(() => screen.getByTestId("status-sunset.jpg"));
    mockSetUploadBadge.mockClear();

    // Two ticks that leave the whole-batch percentage where it was: the second
    // re-renders but must not cost another IPC round trip.
    emit(fileEvent("beach.jpg", "uploading", 50));
    emit(fileEvent("beach.jpg", "uploading", 50));

    await waitFor(() => expect(mockSetUploadBadge).toHaveBeenCalledWith(25));
    expect(mockSetUploadBadge).toHaveBeenCalledTimes(1);
  });
});

// A dialog staging a drop for a folder that doesn't exist yet: it registers a
// sink and marks its surface with data-drop-sink.
function SinkConsumer({ onDrop }: { onDrop: (paths: string[]) => void }) {
  const { registerDropSink, overDropSink } = useUpload();
  useEffect(() => registerDropSink(onDrop), [registerDropSink, onDrop]);
  return (
    <>
      <div data-drop-sink data-testid="sink">
        {overDropSink ? "over" : "away"}
      </div>
      <div data-drop-folder="vacation" data-testid="card" />
    </>
  );
}

/** Aim the native cursor at an element: the provider hit-tests the DOM, which
 * jsdom has no layout for, so the lookup is answered directly. */
function aimAt(testId: string) {
  document.elementFromPoint = () => screen.getByTestId(testId);
}

function fireDrag(payload: Record<string, unknown>) {
  act(() => {
    hoisted.dragDrop?.({ payload: { position: { x: 1, y: 1 }, ...payload } });
  });
}

describe("UploadProvider drop sink", () => {
  it("hands a drop on the sink to the dialog instead of importing it", () => {
    const staged = vi.fn();
    render(
      <UploadProvider>
        <SinkConsumer onDrop={staged} />
      </UploadProvider>
    );

    aimAt("sink");
    fireDrag({ type: "over" });
    expect(screen.getByTestId("sink")).toHaveTextContent("over");

    // The junk in the drop never reaches the dialog — only importable images.
    fireDrag({ type: "drop", paths: ["/tmp/a.jpg", "/tmp/notes.txt"] });

    expect(staged).toHaveBeenCalledWith(["/tmp/a.jpg"]);
    expect(mockImportPhotos).not.toHaveBeenCalled();
    expect(screen.getByTestId("sink")).toHaveTextContent("away");
  });

  it("still imports a drop that lands on a folder card", async () => {
    const staged = vi.fn();
    render(
      <UploadProvider>
        <SinkConsumer onDrop={staged} />
      </UploadProvider>
    );

    aimAt("card");
    fireDrag({ type: "drop", paths: ["/tmp/a.jpg"] });

    await waitFor(() =>
      expect(mockImportPhotos).toHaveBeenCalledWith(["/tmp/a.jpg"], "vacation")
    );
    expect(staged).not.toHaveBeenCalled();
  });

  it("goes back to importing once the dialog unregisters", () => {
    const staged = vi.fn();
    const { unmount } = render(
      <UploadProvider>
        <SinkConsumer onDrop={staged} />
      </UploadProvider>
    );
    const sink = screen.getByTestId("sink");
    unmount();

    // The sink element is gone with the dialog; a stale hit-test must not
    // swallow the drop.
    document.elementFromPoint = () => sink;
    fireDrag({ type: "drop", paths: ["/tmp/a.jpg"] });

    expect(staged).not.toHaveBeenCalled();
  });
});
