import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { UploadDropzone } from "@/components/upload-dropzone";

afterEach(() => {
  cleanup();
});

describe("UploadDropzone", () => {
  it("renders the drop zone with default folder", () => {
    render(<UploadDropzone />);

    expect(
      screen.getByText("Drop images here or click to select")
    ).toBeInTheDocument();
    expect(screen.getByText("inbox/")).toBeInTheDocument();
  });

  it("renders with a custom folder name", () => {
    render(<UploadDropzone folder="barcelona" />);

    expect(screen.getByText("barcelona/")).toBeInTheDocument();
  });

  it("highlights on drag over", () => {
    render(<UploadDropzone />);

    const dropZone = screen
      .getByText("Drop images here or click to select")
      .closest("div[class*='border-dashed']")!;

    fireEvent.dragOver(dropZone);
    expect(dropZone.className).toContain("border-blue-500");
  });

  it("removes highlight on drag leave", () => {
    render(<UploadDropzone />);

    const dropZone = screen
      .getByText("Drop images here or click to select")
      .closest("div[class*='border-dashed']")!;

    fireEvent.dragOver(dropZone);
    fireEvent.dragLeave(dropZone);
    expect(dropZone.className).not.toContain("border-blue-500");
  });
});
