import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateBadge } from "@/components/update-badge";
import { UpdatePrompt } from "@/components/update-prompt";
import {
  UpdateContext,
  type UpdateContextValue,
} from "@/lib/update-context";

// The install path dynamically imports the process plugin to relaunch.
const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

function makeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: "- Fixed a bug\n- Added a thing",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Update;
}

function renderWithUpdate(
  ui: React.ReactElement,
  value: Partial<UpdateContextValue> = {}
) {
  const ctx: UpdateContextValue = {
    update: null,
    isDialogOpen: false,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    presentUpdate: vi.fn(),
    ...value,
  };
  render(<UpdateContext.Provider value={ctx}>{ui}</UpdateContext.Provider>);
  return ctx;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UpdateBadge", () => {
  it("renders nothing when no update is pending", () => {
    renderWithUpdate(<UpdateBadge />, { update: null });
    expect(screen.queryByText(/new version/i)).not.toBeInTheDocument();
  });

  it("shows the pill and opens the dialog when clicked", () => {
    const ctx = renderWithUpdate(<UpdateBadge />, { update: makeUpdate() });

    const button = screen.getByRole("button", { name: /new version available/i });
    expect(button).toHaveAttribute("aria-label", expect.stringContaining("0.2.0"));

    fireEvent.click(button);
    expect(ctx.openDialog).toHaveBeenCalledOnce();
  });
});

describe("UpdatePrompt", () => {
  it("renders nothing while the dialog is closed", () => {
    renderWithUpdate(<UpdatePrompt />, {
      update: makeUpdate(),
      isDialogOpen: false,
    });
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it("shows the offer with versions and release notes when open", () => {
    renderWithUpdate(<UpdatePrompt />, {
      update: makeUpdate(),
      isDialogOpen: true,
    });

    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText(/0\.2\.0 is available/)).toBeInTheDocument();
    expect(screen.getByText(/you have 0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Fixed a bug/)).toBeInTheDocument();
  });

  it("dismisses on Later without installing", () => {
    const update = makeUpdate();
    const ctx = renderWithUpdate(<UpdatePrompt />, {
      update,
      isDialogOpen: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /later/i }));
    expect(ctx.closeDialog).toHaveBeenCalledOnce();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("downloads, installs, and relaunches on confirm", async () => {
    const update = makeUpdate();
    renderWithUpdate(<UpdatePrompt />, { update, isDialogOpen: true });

    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  });

  it("shows an inline error when the install fails", async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("boom")),
    } as Partial<Update>);
    renderWithUpdate(<UpdatePrompt />, { update, isDialogOpen: true });

    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));

    await waitFor(() =>
      expect(screen.getByText("Update failed")).toBeInTheDocument()
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

/**
 * Drives the Tauri download callback by hand so the Started/Progress/Finished
 * state machine and the indeterminate-bar branch are actually exercised (the
 * happy-path test above resolves without ever emitting an event).
 */
describe("UpdatePrompt download progress", () => {
  // downloadAndInstall(cb) that hands the callback back to the test and blocks
  // until we resolve it, so intermediate phases can be observed.
  function deferredInstall() {
    let emit!: (e: unknown) => void;
    let finish!: () => void;
    const fn = vi.fn((cb: (e: unknown) => void) => {
      emit = cb;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    return { fn, emit: (e: unknown) => emit(e), finish: () => finish() };
  }

  it("reports percentage during a sized download, then Installing…", async () => {
    const d = deferredInstall();
    const update = makeUpdate({ downloadAndInstall: d.fn } as Partial<Update>);
    renderWithUpdate(<UpdatePrompt />, { update, isDialogOpen: true });

    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));

    act(() => d.emit({ event: "Started", data: { contentLength: 100 } }));
    act(() => d.emit({ event: "Progress", data: { chunkLength: 40 } }));
    expect(screen.getByText(/downloading… 40%/i)).toBeInTheDocument();

    act(() => d.emit({ event: "Progress", data: { chunkLength: 60 } }));
    // 100/100 = 1, but the label must NOT say "Installing…" until Finished.
    expect(screen.getByText(/downloading… 100%/i)).toBeInTheDocument();
    expect(screen.queryByText(/installing/i)).not.toBeInTheDocument();

    act(() => d.emit({ event: "Finished" }));
    expect(screen.getByText(/installing/i)).toBeInTheDocument();

    await act(async () => {
      d.finish();
    });
    await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  });

  it("shows an indeterminate bar when the total size is unknown", () => {
    const d = deferredInstall();
    const update = makeUpdate({ downloadAndInstall: d.fn } as Partial<Update>);
    renderWithUpdate(<UpdatePrompt />, { update, isDialogOpen: true });

    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    // No contentLength -> indeterminate: label stays generic and the bar uses
    // the sweeping segment rather than a full/complete-looking bar.
    act(() => d.emit({ event: "Started", data: {} }));

    expect(screen.getByText(/^downloading…$/i)).toBeInTheDocument();
    expect(document.querySelector(".progress-indeterminate")).not.toBeNull();
  });

  it("swallows Escape mid-install without dismissing or leaking", () => {
    const docEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") docEscape();
    };
    document.addEventListener("keydown", listener);

    const d = deferredInstall();
    const update = makeUpdate({ downloadAndInstall: d.fn } as Partial<Update>);
    const ctx = renderWithUpdate(<UpdatePrompt />, {
      update,
      isDialogOpen: true,
    });

    // Enter the busy phase — the install promise stays pending.
    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));

    fireEvent.keyDown(document.body, { key: "Escape" });

    // Escape is still swallowed (no selection-clear leak) but the dialog must
    // NOT be dismissed mid-install.
    expect(docEscape).not.toHaveBeenCalled();
    expect(ctx.closeDialog).not.toHaveBeenCalled();

    document.removeEventListener("keydown", listener);
  });
});

describe("UpdatePrompt Escape handling", () => {
  it("dismisses without leaking Escape to document-level handlers", () => {
    // Sibling views (photo-grid/search-results) clear their selection on a
    // document-level Escape; the modal must swallow it in the capture phase.
    const docEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") docEscape();
    };
    document.addEventListener("keydown", listener);

    const ctx = renderWithUpdate(<UpdatePrompt />, {
      update: makeUpdate(),
      isDialogOpen: true,
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(ctx.closeDialog).toHaveBeenCalledOnce();
    expect(docEscape).not.toHaveBeenCalled();

    document.removeEventListener("keydown", listener);
  });
});
