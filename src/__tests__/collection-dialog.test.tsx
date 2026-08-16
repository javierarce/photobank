import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { CollectionDialog } from "@/components/collection-dialog";
import {
  addPhotosToCollection,
  createCollection,
  removePhotosFromCollections,
} from "@/lib/api";
import { makeCollection, makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  createCollection: vi.fn(),
  addPhotosToCollection: vi.fn(),
  removePhotosFromCollections: vi.fn(),
}));

const photos = [
  makePhoto({ id: "a", filename: "a.jpg", folder: "trips" }),
  makePhoto({ id: "b", filename: "b.jpg", folder: "trips" }),
];

function open(collections = [] as ReturnType<typeof makeCollection>[]) {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(
    <CollectionDialog
      photos={photos}
      folder="trips"
      collections={collections}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
  return { onApplied, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createCollection).mockResolvedValue(makeCollection());
  vi.mocked(addPhotosToCollection).mockResolvedValue(makeCollection());
  vi.mocked(removePhotosFromCollections).mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("CollectionDialog", () => {
  it("creates a collection from the selection", async () => {
    const { onApplied } = open();

    fireEvent.change(screen.getByTestId("collect-new-title-input"), {
      target: { value: "  Day one  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      // Trimmed on the way out (the backend folds whitespace too, so the two
      // agree on what counts as the same title).
      expect(createCollection).toHaveBeenCalledWith("trips", "Day one", [
        "a",
        "b",
      ])
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("won't create a collection with no title", () => {
    open();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("defaults to the newest collection and adds to it", async () => {
    const { onApplied } = open([
      makeCollection({ id: "new", title: "Day two", photoIds: [] }),
      makeCollection({ id: "old", title: "Day one", photoIds: ["z"] }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(addPhotosToCollection).toHaveBeenCalledWith("new", ["a", "b"])
    );
    expect(createCollection).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("adds to whichever collection is picked", async () => {
    open([
      makeCollection({ id: "new", title: "Day two" }),
      makeCollection({ id: "old", title: "Day one" }),
    ]);

    fireEvent.click(screen.getByRole("radio", { name: /Day one/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(addPhotosToCollection).toHaveBeenCalledWith("old", ["a", "b"])
    );
  });

  it("only offers Remove when some of the selection is filed", async () => {
    cleanup();
    open([makeCollection({ id: "c1", photoIds: [] })]);
    expect(screen.queryByTestId("collection-remove")).toBeNull();

    cleanup();
    const { onApplied } = open([makeCollection({ id: "c1", photoIds: ["a"] })]);
    fireEvent.click(screen.getByTestId("collection-remove"));

    await waitFor(() =>
      // Both selected photos are passed: the backend skips the ones that
      // weren't in a collection anyway.
      expect(removePhotosFromCollections).toHaveBeenCalledWith(["a", "b"])
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("shows the backend's message when the title is taken", async () => {
    vi.mocked(createCollection).mockRejectedValue(
      "This folder already has a collection called “Day one”"
    );
    const { onApplied } = open();

    fireEvent.change(screen.getByTestId("collect-new-title-input"), {
      target: { value: "Day one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/already has a collection called/)
    ).toBeInTheDocument();
    // The dialog stays open on failure so the title can be corrected.
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByTestId("collect-new-title-input")).toBeInTheDocument();
  });
});
