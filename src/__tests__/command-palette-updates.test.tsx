import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Update } from "@tauri-apps/plugin-updater";
import { CommandPalette } from "@/components/command-palette";
import { ThemeProvider } from "@/lib/theme";
import {
  UpdateContext,
  type UpdateContextValue,
} from "@/lib/update-context";
import { listFolders } from "@/lib/api";
import { checkForUpdate } from "@/lib/updater";

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("@/lib/api", () => ({ listFolders: vi.fn() }));

// In the desktop app the palette gains a "Check for updates" action.
vi.mock("@/lib/updater", () => ({
  isTauri: () => true,
  checkForUpdate: vi.fn(),
}));

const mockCheck = vi.mocked(checkForUpdate);

function makeUpdate(): Update {
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: "notes",
    downloadAndInstall: vi.fn(),
  } as unknown as Update;
}

function renderPalette(value: Partial<UpdateContextValue> = {}) {
  const ctx: UpdateContextValue = {
    update: null,
    isDialogOpen: false,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    presentUpdate: vi.fn(),
    ...value,
  };
  render(
    <ThemeProvider>
      <UpdateContext.Provider value={ctx}>
        <MemoryRouter>
          <CommandPalette />
        </MemoryRouter>
      </UpdateContext.Provider>
    </ThemeProvider>
  );
  return ctx;
}

function pressCmdK() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.mocked(listFolders).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("CommandPalette updates action", () => {
  it("lists a Check for updates action in the desktop app", () => {
    renderPalette();
    pressCmdK();
    expect(screen.getByText("Check for updates")).toBeInTheDocument();
  });

  it("filters to it by keyword", () => {
    renderPalette();
    pressCmdK();
    fireEvent.change(screen.getByPlaceholderText(/search folders or actions/i), {
      target: { value: "upgrade" },
    });
    expect(screen.getByText("Check for updates")).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
  });

  it("checks and presents a found update", async () => {
    const update = makeUpdate();
    mockCheck.mockResolvedValue(update);
    const ctx = renderPalette();
    pressCmdK();

    fireEvent.click(screen.getByText("Check for updates"));

    await waitFor(() => expect(mockCheck).toHaveBeenCalledOnce());
    await waitFor(() => expect(ctx.presentUpdate).toHaveBeenCalledWith(update));
  });

  it("jumps straight to the install dialog when an update is pending", () => {
    const ctx = renderPalette({ update: makeUpdate() });
    pressCmdK();

    // The action relabels to carry the pending version.
    fireEvent.click(screen.getByText("Update to Photobank 0.2.0"));

    expect(ctx.openDialog).toHaveBeenCalledOnce();
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
