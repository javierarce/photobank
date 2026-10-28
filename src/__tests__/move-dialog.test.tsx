import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MoveDialogProvider } from "@/components/move-dialog";
import { useMoveDestination } from "@/lib/move-context";

vi.mock("@/lib/api", () => ({
  listFolders: vi.fn().mockResolvedValue([{ folder: "Travel" }]),
}));

function Harness() {
  const choose = useMoveDestination();
  const [chosen, setChosen] = useState("Waiting");
  return <>
    <button onClick={async () => setChosen((await choose("inbox")) ?? "Cancelled")}>Choose folder</button>
    <p>{chosen}</p>
  </>;
}

function openDialog() {
  render(<MoveDialogProvider><Harness /></MoveDialogProvider>);
  const trigger = screen.getByRole("button", { name: "Choose folder" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

afterEach(cleanup);

describe("Move dialog", () => {
  it("validates and returns a destination without window.prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    openDialog();
    const input = screen.getByRole("combobox", { name: "Destination folder" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "nested/folder" } });
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Travel  " } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(await screen.findByText("Travel")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("cancels on Escape without passing it to the underlying photo view", async () => {
    const underlyingEscape = vi.fn();
    document.addEventListener("keydown", underlyingEscape);
    const trigger = openDialog();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(underlyingEscape).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    document.removeEventListener("keydown", underlyingEscape);
  });

  it("keeps Tab focus inside the modal and cancels without choosing", async () => {
    openDialog();
    const move = screen.getByRole("button", { name: "Move" });
    move.focus();
    fireEvent.keyDown(move, { key: "Tab" });
    expect(screen.getByRole("combobox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });
});
