import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { NewCollectionDialog } from "@/components/new-collection-dialog";
import { createCollection } from "@/lib/api";
import { makeCollection } from "./fixtures";

vi.mock("@/lib/api", () => ({ createCollection: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createCollection).mockResolvedValue(makeCollection());
});

afterEach(() => cleanup());

function open() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <NewCollectionDialog
      folder="vacation"
      onClose={onClose}
      onCreated={onCreated}
    />
  );
  return { onCreated, onClose };
}

describe("NewCollectionDialog", () => {
  it("creates an empty collection in the folder", async () => {
    const { onCreated } = open();

    fireEvent.change(screen.getByTestId("new-collection-input"), {
      target: { value: "  Day one  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // Empty on purpose: the card it makes is the drop target photos go onto.
    await waitFor(() =>
      expect(createCollection).toHaveBeenCalledWith("vacation", "Day one", [])
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("won't create one without a title", () => {
    open();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.change(screen.getByTestId("new-collection-input"), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("commits on Enter", async () => {
    open();

    const input = screen.getByTestId("new-collection-input");
    fireEvent.change(input, { target: { value: "Day one" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createCollection).toHaveBeenCalledWith("vacation", "Day one", [])
    );
  });

  it("shows the backend's message when the title is taken", async () => {
    vi.mocked(createCollection).mockRejectedValue(
      "This folder already has a collection called “Day one”"
    );
    const { onCreated } = open();

    fireEvent.change(screen.getByTestId("new-collection-input"), {
      target: { value: "Day one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/already has a collection called/)
    ).toBeInTheDocument();
    // The dialog stays open so the title can be corrected.
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-collection-input")).toBeInTheDocument();
  });
});
