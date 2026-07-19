import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
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
