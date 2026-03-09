import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PhotoLightbox } from "@/components/photo-lightbox";
import type { Photo } from "@/lib/types";

vi.mock("@/components/photo-tags", () => ({
  PhotoTags: ({ photoId }: { photoId: string }) => (
    <div data-testid="photo-tags">{photoId}</div>
  ),
}));

const photo: Photo = {
  id: "1",
  filename: "test.jpg",
  s3Key: "inbox/test.jpg",
  folder: "inbox",
  width: 1920,
  height: 1080,
  processingStatus: "completed",
  cameraMake: "Ricoh",
  cameraModel: "GR III",
  lens: "GR Lens 18.3mm f/2.8",
  focalLength: "18.3mm",
  aperture: "f/2.8",
  shutterSpeed: "1/250s",
  iso: 200,
  takenAt: "2026-01-15T12:00:00Z",
  gpsLatitude: null,
  gpsLongitude: null,
};

afterEach(() => {
  cleanup();
});

describe("PhotoLightbox", () => {
  it("renders photo metadata", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    expect(screen.getByText("test.jpg")).toBeInTheDocument();
    expect(screen.getByText("inbox/")).toBeInTheDocument();
    expect(screen.getByText("Ricoh GR III")).toBeInTheDocument();
    expect(screen.getByText("GR Lens 18.3mm f/2.8")).toBeInTheDocument();
    expect(screen.getByText("18.3mm · f/2.8 · 1/250s · ISO 200")).toBeInTheDocument();
    expect(screen.getByText(/1920/)).toBeInTheDocument();
  });

  it("calls onClose when pressing Escape", () => {
    const onClose = vi.fn();
    render(<PhotoLightbox photo={photo} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows action buttons when callbacks are provided", () => {
    render(
      <PhotoLightbox
        photo={photo}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
        onRename={vi.fn()}
      />
    );

    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Move")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("hides action buttons when callbacks are not provided", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    expect(screen.queryByText("Move")).not.toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("shows spinner before image loads and hides it after", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    const img = screen.getByAltText("test.jpg");
    expect(img).toHaveClass("opacity-0");
    expect(document.querySelector("svg.animate-spin")).toBeInTheDocument();

    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
    expect(document.querySelector("svg.animate-spin")).not.toBeInTheDocument();
  });

  it("calls onDelete when Delete is clicked", () => {
    const onDelete = vi.fn();
    render(
      <PhotoLightbox photo={photo} onClose={vi.fn()} onDelete={onDelete} />
    );

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(photo);
  });
});
