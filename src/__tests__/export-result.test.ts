import { beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "@tauri-apps/plugin-dialog";
import { showExportResult } from "@/lib/export-result";

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.clearAllMocks());

describe("export summary", () => {
  it("reports partial failures with the actual written count and filenames", async () => {
    await showExportResult({ path: "/test/export", requested: 3, written: 2,
      failures: [{ filename: "lost.jpg", error: "Download failed" }] });
    expect(message).toHaveBeenCalledWith(
      expect.stringMatching(/Exported 2 of 3.*\n\nCould not export:\nlost.jpg: Download failed/),
      { title: "Export complete", kind: "warning" }
    );
  });

  it("reports when every file failed", async () => {
    await showExportResult({ path: "/test/export", requested: 2, written: 0,
      failures: [{ filename: "a.jpg", error: "Offline" }, { filename: "b.jpg", error: "Offline" }] });
    expect(message).toHaveBeenCalledWith(expect.stringContaining("Exported 0 of 2"), expect.objectContaining({ kind: "warning" }));
  });

  it("does not announce a cancelled export or a successful single save", async () => {
    await showExportResult(null);
    await showExportResult({ path: "/test/a.jpg", requested: 1, written: 1, failures: [] });
    expect(message).not.toHaveBeenCalled();
  });
});
