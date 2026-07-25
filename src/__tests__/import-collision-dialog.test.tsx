import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ImportCollisionDialog } from "@/components/import-collision-dialog";

afterEach(() => {
  cleanup();
});

function renderDialog(
  collisions: string[],
  total = collisions.length,
  onChoose = vi.fn()
) {
  render(
    <ImportCollisionDialog
      folder="vacation"
      collisions={collisions}
      total={total}
      onChoose={onChoose}
    />
  );
  return onChoose;
}

describe("ImportCollisionDialog", () => {
  it("names the single clashing file", () => {
    renderDialog(["beach.jpg"]);

    expect(
      screen.getByText("A photo with that name already exists")
    ).toBeInTheDocument();
    expect(screen.getByTestId("collision-list")).toHaveTextContent("beach.jpg");
  });

  it("counts them when several clash", () => {
    renderDialog(["a.jpg", "b.jpg", "c.jpg"]);

    expect(
      screen.getByText("3 photos with those names already exist")
    ).toBeInTheDocument();
  });

  it("caps the list so a big drop can't run off the dialog", () => {
    renderDialog(["a", "b", "c", "d", "e", "f", "g"].map((n) => `${n}.jpg`));

    const list = screen.getByTestId("collision-list");
    expect(list).toHaveTextContent("e.jpg");
    expect(list).not.toHaveTextContent("f.jpg");
    expect(list).toHaveTextContent("and 2 more");
  });

  it("reassures that the non-clashing files upload regardless", () => {
    // 1 of 4 clashes, so 3 are unaffected by whichever button is pressed.
    renderDialog(["beach.jpg"], 4);

    expect(screen.getByText(/other 3 files/)).toBeInTheDocument();
  });

  it("says nothing about other files when every file clashes", () => {
    renderDialog(["beach.jpg"], 1);

    expect(screen.queryByText(/other/)).not.toBeInTheDocument();
    // With nothing else in the drop, Skip cancels rather than "skips these".
    expect(screen.getByTestId("collision-skip")).toHaveTextContent("Skip");
  });

  it("reports each choice to the caller", () => {
    const onChoose = renderDialog(["beach.jpg"]);

    fireEvent.click(screen.getByTestId("collision-replace"));
    expect(onChoose).toHaveBeenCalledWith("replace");

    fireEvent.click(screen.getByTestId("collision-keep-both"));
    expect(onChoose).toHaveBeenCalledWith("keep-both");

    fireEvent.click(screen.getByTestId("collision-skip"));
    expect(onChoose).toHaveBeenCalledWith("skip");
  });

  it("reports null when dismissed, so the drop is abandoned", () => {
    const onChoose = renderDialog(["beach.jpg"]);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onChoose).toHaveBeenCalledWith(null);
  });

  it("shows the user-facing name, not the legacy stored one", () => {
    // Old-pipeline photos are stored as "<base>_original.jpg"; the dialog has
    // to match what the grid and lightbox call them.
    renderDialog(["R0007098_original.jpg"]);

    const list = screen.getByTestId("collision-list");
    expect(list).toHaveTextContent("R0007098.jpg");
    expect(list).not.toHaveTextContent("_original");
  });
});
