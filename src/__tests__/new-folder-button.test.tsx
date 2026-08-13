import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  useParams,
} from "react-router-dom";
import { NewFolderButton } from "@/components/new-folder-button";

// The dialog talks to the upload provider for staging (drop sink + picker) and
// for the import it kicks off; stub it and capture what it's asked to do.
const upload = vi.hoisted(() => ({
  importPaths: vi.fn(),
  pickImages: vi.fn(async () => [] as string[]),
  overDropSink: false,
  /** The dialog's staging handler, as registered with the provider. */
  sink: null as null | ((paths: string[]) => void),
}));

vi.mock("@/hooks/use-upload", () => ({
  useUpload: () => ({
    importPaths: upload.importPaths,
    pickImages: upload.pickImages,
    overDropSink: upload.overDropSink,
    registerDropSink: (fn: (paths: string[]) => void) => {
      upload.sink = fn;
      return () => {
        if (upload.sink === fn) upload.sink = null;
      };
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  upload.sink = null;
  upload.overDropSink = false;
  upload.pickImages.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

// react-router decodes the route param (see routes/folder.tsx), so this reports
// the folder name exactly as the folder page would receive it.
function FolderProbe() {
  return <div data-testid="folder-param">{useParams().folder}</div>;
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderButton(existing: string[] = []) {
  return render(
    <MemoryRouter>
      <NewFolderButton existing={existing} />
      <Routes>
        <Route path="/folders/:folder" element={<FolderProbe />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Open the dialog and return its name field. */
function openDialog() {
  fireEvent.click(screen.getByTestId("new-folder-button"));
  return screen.getByTestId("new-folder-input");
}

const confirm = () => screen.getByRole("button", { name: /^Create/ });

/** Stand in for a native drop on the dialog (Tauri routes it to the sink). */
function drop(paths: string[]) {
  act(() => {
    upload.sink?.(paths);
  });
}

describe("NewFolderButton", () => {
  it("opens a modal with a name field rather than editing in place", () => {
    renderButton();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const input = openDialog();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(input).toHaveFocus();
    // Nothing to create until it's named.
    expect(confirm()).toBeDisabled();
  });

  it("takes a drop anywhere on the card, not just on the box", () => {
    renderButton();

    openDialog();
    // The provider hit-tests this attribute to divert the native drop.
    expect(screen.getByRole("dialog")).toHaveAttribute("data-drop-sink");
  });

  it("navigates to a newly named folder's page", async () => {
    renderButton(["vacation"]);

    fireEvent.change(openDialog(), { target: { value: "  My Trip  " } });
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("My Trip");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(upload.importPaths).not.toHaveBeenCalled();
  });

  it("creates on Enter in the name field", async () => {
    renderButton();

    const input = openDialog();
    fireEvent.change(input, { target: { value: "berlin" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("berlin");
    });
  });

  it("folds away slashes, which would fracture the key scheme", async () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "trips/2026" } });
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("trips 2026");
    });
  });

  it("opens the existing folder when the name matches (case-insensitively)", async () => {
    renderButton(["Vacation"]);

    fireEvent.change(openDialog(), { target: { value: "vacation" } });
    // The mismatch in casing is called out before it's confirmed.
    expect(screen.getByText(/Opens the existing folder/)).toBeInTheDocument();
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("Vacation");
    });
  });

  it("uploads the photos dropped on the dialog into the new folder", async () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "berlin" } });
    drop(["/tmp/a.jpg", "/tmp/b.jpg"]);

    // Each staged file previews its own pixels, read off disk.
    const previews = screen.getAllByRole("img");
    expect(previews.map((img) => img.getAttribute("src"))).toEqual([
      "preview://localhost/%2Ftmp%2Fa.jpg",
      "preview://localhost/%2Ftmp%2Fb.jpg",
    ]);
    expect(screen.getByText("2 photos to upload")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create and upload 2" }));

    await waitFor(() => {
      expect(screen.getByTestId("folder-param")).toHaveTextContent("berlin");
    });
    expect(upload.importPaths).toHaveBeenCalledWith(
      ["/tmp/a.jpg", "/tmp/b.jpg"],
      "berlin"
    );
  });

  it("stages a second drop without duplicating what's already there", () => {
    renderButton();

    openDialog();
    drop(["/tmp/a.jpg"]);
    drop(["/tmp/a.jpg", "/tmp/b.jpg"]);

    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText("2 photos to upload")).toBeInTheDocument();
  });

  it("drops a staged photo back out of the batch", () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "berlin" } });
    drop(["/tmp/a.jpg", "/tmp/b.jpg"]);

    fireEvent.click(screen.getByLabelText("Remove a.jpg"));

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("1 photo to upload")).toBeInTheDocument();

    fireEvent.click(confirm());
    expect(upload.importPaths).toHaveBeenCalledWith(["/tmp/b.jpg"], "berlin");
  });

  it("clears a whole mistaken batch at once", () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "berlin" } });
    drop(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);

    fireEvent.click(screen.getByTestId("new-folder-clear"));

    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByTestId("new-folder-clear")).not.toBeInTheDocument();
    // The folder is still worth creating on its own.
    expect(confirm()).toHaveTextContent("Create");
    fireEvent.click(confirm());
    expect(upload.importPaths).not.toHaveBeenCalled();
  });

  it("scrolls a big batch instead of growing the dialog", () => {
    renderButton();

    openDialog();
    drop(Array.from({ length: 80 }, (_, i) => `/tmp/photo-${i}.jpg`));

    const staged = screen.getByTestId("new-folder-staged");
    expect(staged.className).toContain("overflow-y-auto");
    // Fixed row tracks: 80 tiles stack into rows rather than collapsing on top
    // of each other.
    expect(staged.className).toContain("auto-rows-[72px]");
    expect(screen.getAllByRole("img")).toHaveLength(80);
  });

  it("stages the file picker's selection too", async () => {
    upload.pickImages.mockResolvedValueOnce(["/tmp/picked.jpg"]);
    renderButton();

    openDialog();
    fireEvent.click(screen.getByTestId("new-folder-choose"));

    await waitFor(() => {
      expect(screen.getByText("1 photo to upload")).toBeInTheDocument();
    });
  });

  it("closes on Escape typed in the name field", () => {
    renderButton();

    // The field is focused on open, so this is where Escape is actually
    // pressed — it must reach the dialog rather than die on the input.
    const input = openDialog();
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("closes on Escape without creating anything", () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "scratch" } });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(upload.importPaths).not.toHaveBeenCalled();
  });

  it("closes on Cancel and forgets what was staged", () => {
    renderButton();

    fireEvent.change(openDialog(), { target: { value: "scratch" } });
    drop(["/tmp/a.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(openDialog()).toHaveValue("");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("releases the drop sink when it closes", () => {
    renderButton();

    openDialog();
    expect(upload.sink).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(upload.sink).toBeNull();
  });
});
