import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TagInput } from "@/components/tag-input";

afterEach(() => cleanup());

/** Controlled wrapper mirroring how parents drive TagInput. */
function Harness({
  initial = [],
  suggestions = [],
  onSubmit,
  onInputChange,
}: {
  initial?: string[];
  suggestions?: string[];
  onSubmit?: () => void;
  onInputChange?: (v: string) => void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <TagInput
      tags={tags}
      onChange={setTags}
      suggestions={suggestions}
      onSubmit={onSubmit}
      onInputChange={onInputChange}
    />
  );
}

describe("TagInput", () => {
  it("adds a chip on Enter and clears the field", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sunset" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("sunset")).toBeInTheDocument();
    expect(input.value).toBe("");
  });

  it("commits the typed text on comma", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "beach" } });
    fireEvent.keyDown(input, { key: "," });
    expect(screen.getByText("beach")).toBeInTheDocument();
  });

  it("does not add duplicate chips", () => {
    render(<Harness initial={["sunset"]} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "sunset" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByText("sunset")).toHaveLength(1);
  });

  it("filters suggestions and excludes already-applied tags", () => {
    render(<Harness initial={["Landscape"]} suggestions={["Landscape", "Portrait", "Street"]} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "r" } });
    // Portrait and Street contain "r"; Landscape is applied so it's excluded
    // from suggestions — it appears only as the existing chip (once).
    expect(screen.getByText("Portrait")).toBeInTheDocument();
    expect(screen.getByText("Street")).toBeInTheDocument();
    expect(screen.getAllByText("Landscape")).toHaveLength(1);
  });

  it("accepts the highlighted suggestion on Enter", () => {
    render(<Harness suggestions={["Portrait", "Panorama"]} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "P" } });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight second
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Panorama")).toBeInTheDocument();
    expect(screen.queryByText("Portrait")).not.toBeInTheDocument();
  });

  it("removes the last chip on Backspace when the field is empty", () => {
    render(<Harness initial={["a", "b"]} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByText("b")).not.toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("calls onSubmit on a second Enter with an empty field", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("reports uncommitted text via onInputChange", () => {
    const onInputChange = vi.fn();
    render(<Harness onInputChange={onInputChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "wip" } });
    expect(onInputChange).toHaveBeenLastCalledWith("wip");
  });
});
