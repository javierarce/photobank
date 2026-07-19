import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { FolderTitle } from "@/components/folder-title";
import { renameFolder } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  renameFolder: vi.fn(),
}));

const mockRenameFolder = vi.mocked(renameFolder);

/** Renders the title inside a real route so the post-rename navigation is
 * observable via the probe's pathname. */
function Probe() {
  const { pathname } = useLocation();
  return <p data-testid="pathname">{pathname}</p>;
}

function Harness({
  folder,
  initialEditing,
  onRenamingChange,
}: {
  folder: string;
  initialEditing: boolean;
  onRenamingChange?: (renaming: boolean) => void;
}) {
  const [editing, setEditing] = useState(initialEditing);
  return (
    <>
      <FolderTitle
        folder={folder}
        editing={editing}
        onEditingChange={setEditing}
        onRenamingChange={onRenamingChange}
      />
      <Probe />
    </>
  );
}

function renderTitle({
  folder = "trips",
  initialEditing = true,
  onRenamingChange = undefined as ((renaming: boolean) => void) | undefined,
} = {}) {
  return render(
    <MemoryRouter initialEntries={[`/folders/${encodeURIComponent(folder)}`]}>
      <Routes>
        <Route
          path="/folders/:folder"
          element={
            <Harness
              folder={folder}
              initialEditing={initialEditing}
              onRenamingChange={onRenamingChange}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FolderTitle", () => {
  it("shows a plain title when not editing", () => {
    renderTitle({ initialEditing: false });

    expect(screen.getByTestId("folder-title")).toHaveTextContent("trips");
    expect(screen.queryByTestId("folder-title-input")).not.toBeInTheDocument();
  });

  it("commits on blur and navigates to the renamed folder", async () => {
    mockRenameFolder.mockResolvedValueOnce(2);
    renderTitle();

    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: " voyages " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockRenameFolder).toHaveBeenCalledWith("trips", "voyages");
    });
    await waitFor(() => {
      expect(screen.getByTestId("pathname")).toHaveTextContent(
        "/folders/voyages"
      );
    });
  });

  it("cancels on Escape without calling the backend", () => {
    renderTitle();

    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: "voyages" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mockRenameFolder).not.toHaveBeenCalled();
    expect(screen.getByTestId("folder-title")).toHaveTextContent("trips");
  });

  it("treats an unchanged or empty name as a no-op", () => {
    renderTitle();

    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: "  trips " } });
    fireEvent.blur(input);

    expect(mockRenameFolder).not.toHaveBeenCalled();
    expect(screen.getByTestId("pathname")).toHaveTextContent("/folders/trips");
  });

  it("reports in-flight state up while the rename runs", async () => {
    let resolveRename!: (moved: number) => void;
    mockRenameFolder.mockReturnValueOnce(
      new Promise((res) => {
        resolveRename = res;
      })
    );
    const onRenamingChange = vi.fn();
    renderTitle({ onRenamingChange });

    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: "voyages" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onRenamingChange).toHaveBeenLastCalledWith(true);
    });
    expect(screen.getByTestId("folder-title")).toHaveTextContent("Renaming…");

    resolveRename(2);
    await waitFor(() => {
      expect(onRenamingChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("surfaces the backend's message inline and stays put on failure", async () => {
    mockRenameFolder.mockRejectedValueOnce(
      "A folder with that name already exists"
    );
    renderTitle();

    const input = screen.getByTestId("folder-title-input");
    fireEvent.change(input, { target: { value: "beach" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByTestId("folder-rename-error")).toHaveTextContent(
        "A folder with that name already exists"
      );
    });
    expect(screen.getByTestId("folder-title")).toHaveTextContent("trips");
    expect(screen.getByTestId("pathname")).toHaveTextContent("/folders/trips");
  });
});
