import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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
import { cancelImport, importPhotos } from "@/lib/api";

// Capture the import://progress listener so tests can emit events, and stub the
// native drag-drop subscription the provider also registers.
const hoisted = vi.hoisted(() => ({
  progress: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (event: { payload: unknown }) => void) => {
    hoisted.progress = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  importPhotos: vi.fn(),
  cancelImport: vi.fn(),
}));

const mockImportPhotos = vi.mocked(importPhotos);
const mockCancelImport = vi.mocked(cancelImport);

// A tiny consumer that renders each upload's status and a cancel button, plus a
// trigger to seed an upload through the file picker (which drives handlePaths).
function Consumer() {
  const { files, openFilePicker, cancelUpload } = useUpload();
  return (
    <div>
      <button onClick={() => openFilePicker("vacation")}>pick</button>
      <ul>
        {files.map((f) => (
          <li key={f.key}>
            <span data-testid={`status-${f.filename}`}>{f.status}</span>
            <button onClick={() => cancelUpload(f.key)}>cancel-{f.filename}</button>
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
  // invoke() always returns a promise; the mock must too, so the provider's
  // `.catch` has something to attach to.
  mockCancelImport.mockResolvedValue(undefined);
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
