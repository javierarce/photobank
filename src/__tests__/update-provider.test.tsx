import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateProvider } from "@/components/update-provider";
import { useUpdate } from "@/lib/update-context";
import { checkForUpdate } from "@/lib/updater";

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

function Consumer() {
  const { update, isDialogOpen, presentUpdate, openDialog, closeDialog } =
    useUpdate();
  return (
    <div>
      <span data-testid="version">{update?.version ?? "none"}</span>
      <span data-testid="dialog">{isDialogOpen ? "open" : "closed"}</span>
      <button onClick={() => presentUpdate(makeUpdate())}>present</button>
      <button onClick={openDialog}>open</button>
      <button onClick={closeDialog}>close</button>
    </div>
  );
}

function renderProvider() {
  render(
    <UpdateProvider>
      <Consumer />
    </UpdateProvider>
  );
}

const version = () => screen.getByTestId("version").textContent;
const dialog = () => screen.getByTestId("dialog").textContent;

beforeEach(() => {
  mockCheck.mockReset();
  mockCheck.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("UpdateProvider", () => {
  it("starts with no update and the dialog closed", () => {
    renderProvider();
    expect(version()).toBe("none");
    expect(dialog()).toBe("closed");
  });

  it("presentUpdate records the update and opens the dialog", () => {
    renderProvider();
    fireEvent.click(screen.getByText("present"));
    expect(version()).toBe("0.2.0");
    expect(dialog()).toBe("open");
  });

  it("openDialog / closeDialog toggle the dialog without an update", () => {
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    expect(dialog()).toBe("open");
    fireEvent.click(screen.getByText("close"));
    expect(dialog()).toBe("closed");
  });

  it("does not run the launch check outside a production build", () => {
    // import.meta.env.PROD is false under test, so the effect must bail.
    renderProvider();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("surfaces a launch-check update as a badge without opening the dialog", async () => {
    vi.stubEnv("PROD", true);
    mockCheck.mockResolvedValue(makeUpdate());

    renderProvider();

    await waitFor(() => expect(version()).toBe("0.2.0"));
    // The badge is now available (update set) but the modal stays closed — the
    // launch check must never interrupt with a dialog.
    expect(dialog()).toBe("closed");
  });
});
