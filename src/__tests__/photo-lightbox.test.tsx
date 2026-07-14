import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { PhotoLightbox } from "@/components/photo-lightbox";
import type { Photo } from "@/lib/types";
import { makePhoto } from "./fixtures";

vi.mock("@/components/photo-tags", () => ({
  PhotoTags: ({ photoId }: { photoId: string }) => (
    <div data-testid="photo-tags">{photoId}</div>
  ),
}));

const exportPhotos = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/api", () => ({
  exportPhotos: (...args: unknown[]) => exportPhotos(...args),
}));

const photo: Photo = makePhoto({
  id: "1",
  filename: "test.jpg",
  s3Key: "inbox/test.jpg",
  folder: "inbox",
  cameraMake: "Ricoh",
  cameraModel: "GR III",
  lens: "GR Lens 18.3mm f/2.8",
  focalLength: "18.3mm",
  aperture: "f/2.8",
  shutterSpeed: "1/250s",
  iso: 200,
  takenAt: "2026-01-15T12:00:00Z",
});

afterEach(() => {
  cleanup();
  exportPhotos.mockClear();
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

  it("navigates with the arrow keys when handlers are provided", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <PhotoLightbox
        photo={photo}
        onClose={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onPrev).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("navigates when the on-screen arrows are clicked", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <PhotoLightbox
        photo={photo}
        onClose={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    fireEvent.click(screen.getByLabelText("Previous photo"));
    expect(onPrev).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("hides navigation arrows at the ends of the list", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    expect(screen.queryByLabelText("Previous photo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Next photo")).not.toBeInTheDocument();
  });

  it("does not navigate while renaming", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <PhotoLightbox
        photo={photo}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    fireEvent.click(screen.getByTestId("filename-display"));
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
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
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("hides action buttons when callbacks are not provided", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    expect(screen.queryByText("Move")).not.toBeInTheDocument();
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("animates the panel and backdrop in on open", () => {
    const { container } = render(
      <PhotoLightbox photo={photo} onClose={vi.fn()} />
    );

    // Backdrop fades in; the panel scales up from center (modal, so centered
    // rather than origin-aware). Never popping in from nothing.
    const backdrop = container.firstElementChild;
    expect(backdrop).toHaveClass("backdrop-in");
    expect(backdrop?.firstElementChild).toHaveClass("modal-in");
  });

  it("has no border in light mode and a gray hairline only in dark", () => {
    const { container } = render(
      <PhotoLightbox photo={photo} onClose={vi.fn()} />
    );

    // The panel carries no border width in light mode — a transparent border
    // would still reserve 1px, and background-clip: border-box would paint the
    // white panel background under it, showing as a 1px white ring. The gray
    // hairline is scoped to dark mode, where it separates the panel from the
    // near-black background.
    const panel = container.firstElementChild?.firstElementChild;
    expect(panel).toHaveClass("border-0", "dark:border", "dark:border-border");
    expect(panel).not.toHaveClass("border-border");
  });

  it("spins the loading indicator faster than the default", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    // A faster spinner makes the load feel quicker at the same latency.
    expect(document.querySelector("svg.animate-spin")).toHaveClass(
      "[animation-duration:0.6s]"
    );
  });

  it("shows spinner before image loads and hides it after", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    const img = screen.getByAltText("test.jpg");
    expect(img).toHaveClass("opacity-0");
    expect(document.querySelector("svg.animate-spin")).toBeInTheDocument();

    // The spinner overlay must be positioned relative to the image column so it
    // stays centered over the photo and not the photo + sidebar.
    const overlay = document.querySelector("svg.animate-spin")?.closest(
      ".absolute",
    );
    expect(overlay?.parentElement).toHaveClass("relative", "bg-black");

    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
    expect(document.querySelector("svg.animate-spin")).not.toBeInTheDocument();
  });

  it("exports the default (2880) version when Download is clicked", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Download"));
    expect(exportPhotos).toHaveBeenCalledWith(["1"], "2880");
  });

  it("exports a chosen version from the split-button menu", () => {
    render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Choose version to export"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    expect(exportPhotos).toHaveBeenCalledWith(["1"], "original");
  });

  it("calls onDelete when Delete is clicked", () => {
    const onDelete = vi.fn();
    render(
      <PhotoLightbox photo={photo} onClose={vi.fn()} onDelete={onDelete} />
    );

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(photo);
  });

  describe("inline filename editing", () => {
    it("displays filename as static text by default", () => {
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={vi.fn()} />
      );

      expect(screen.getByTestId("filename-display")).toHaveTextContent("test.jpg");
      expect(screen.queryByTestId("filename-input")).not.toBeInTheDocument();
    });

    it("enters edit mode when clicking the filename", () => {
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={vi.fn()} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("test");
      expect(screen.getByText(".jpg")).toBeInTheDocument();
    });

    it("does not enter edit mode when onRename is not provided", () => {
      render(<PhotoLightbox photo={photo} onClose={vi.fn()} />);

      fireEvent.click(screen.getByTestId("filename-display"));
      expect(screen.queryByTestId("filename-input")).not.toBeInTheDocument();
    });

    it("calls onRename with full filename on blur", async () => {
      const onRename = vi.fn().mockResolvedValue(undefined);
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "vacation-photo" } });
      await act(() => fireEvent.blur(input));

      expect(onRename).toHaveBeenCalledWith(photo, "vacation-photo.jpg");
    });

    it("calls onRename with full filename on Enter", async () => {
      const onRename = vi.fn().mockResolvedValue(undefined);
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "new-name" } });
      await act(() => fireEvent.keyDown(input, { key: "Enter" }));

      expect(onRename).toHaveBeenCalledWith(photo, "new-name.jpg");
    });

    it("shows new name optimistically after confirming", async () => {
      const onRename = vi.fn().mockResolvedValue(undefined);
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));
      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "new-name" } });
      await act(() => fireEvent.blur(input));

      expect(screen.getByTestId("filename-display")).toHaveTextContent("new-name.jpg");
    });

    it("reverts name and shows error when rename fails", async () => {
      const onRename = vi.fn().mockRejectedValue(new Error("Failed to rename"));
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));
      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "bad-name" } });
      await act(() => fireEvent.blur(input));

      await waitFor(() => {
        expect(screen.getByTestId("rename-error")).toHaveTextContent("Failed to rename file");
      });
      expect(screen.getByTestId("filename-display")).toHaveTextContent("test.jpg");
    });

    it("clears error when starting a new edit", async () => {
      const onRename = vi.fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(undefined);
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      // First attempt fails
      fireEvent.click(screen.getByTestId("filename-display"));
      fireEvent.change(screen.getByTestId("filename-input"), { target: { value: "bad" } });
      await act(() => fireEvent.blur(screen.getByTestId("filename-input")));

      await waitFor(() => {
        expect(screen.getByTestId("rename-error")).toBeInTheDocument();
      });

      // Second attempt — error should clear
      fireEvent.click(screen.getByTestId("filename-display"));
      fireEvent.change(screen.getByTestId("filename-input"), { target: { value: "good" } });
      await act(() => fireEvent.blur(screen.getByTestId("filename-input")));

      expect(screen.queryByTestId("rename-error")).not.toBeInTheDocument();
    });

    it("shows spinner and disables buttons while rename is in progress", async () => {
      let resolveRename!: () => void;
      const onRename = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveRename = resolve; })
      );
      render(
        <PhotoLightbox
          photo={photo}
          onClose={vi.fn()}
          onDelete={vi.fn()}
          onMove={vi.fn()}
          onRename={onRename}
        />
      );

      // Load image first
      fireEvent.load(screen.getByAltText("test.jpg"));
      expect(document.querySelector("svg.animate-spin")).not.toBeInTheDocument();

      // Start rename
      fireEvent.click(screen.getByTestId("filename-display"));
      fireEvent.change(screen.getByTestId("filename-input"), { target: { value: "new" } });
      // Don't await — we want to inspect mid-rename state
      act(() => { fireEvent.blur(screen.getByTestId("filename-input")); });

      // Spinner should be visible
      expect(document.querySelector("svg.animate-spin")).toBeInTheDocument();
      // Buttons should be disabled
      expect(screen.getByText("Move")).toBeDisabled();
      expect(screen.getByText("Delete")).toBeDisabled();
      // Filename should not be clickable (no edit mode)
      fireEvent.click(screen.getByTestId("filename-display"));
      expect(screen.queryByTestId("filename-input")).not.toBeInTheDocument();

      // Resolve the rename
      await act(() => { resolveRename(); });

      // Buttons should be re-enabled
      expect(screen.getByText("Move")).not.toBeDisabled();
      expect(screen.getByText("Delete")).not.toBeDisabled();
    });

    it("cancels editing on Escape without calling onRename", () => {
      const onRename = vi.fn();
      const onClose = vi.fn();
      render(
        <PhotoLightbox photo={photo} onClose={onClose} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "changed" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onRename).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("filename-display")).toHaveTextContent("test.jpg");
    });

    it("does not call onRename when name is unchanged", async () => {
      const onRename = vi.fn();
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      await act(() => fireEvent.blur(input));

      expect(onRename).not.toHaveBeenCalled();
    });

    it("does not call onRename when name is empty or whitespace", async () => {
      const onRename = vi.fn();
      render(
        <PhotoLightbox photo={photo} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "   " } });
      await act(() => fireEvent.blur(input));

      expect(onRename).not.toHaveBeenCalled();
    });

    it("preserves the original file extension", async () => {
      const pngPhoto = { ...photo, filename: "image.png", s3Key: "inbox/image.png" };
      const onRename = vi.fn().mockResolvedValue(undefined);
      render(
        <PhotoLightbox photo={pngPhoto} onClose={vi.fn()} onRename={onRename} />
      );

      fireEvent.click(screen.getByTestId("filename-display"));

      expect(screen.getByText(".png")).toBeInTheDocument();
      const input = screen.getByTestId("filename-input");
      fireEvent.change(input, { target: { value: "renamed" } });
      await act(() => fireEvent.blur(input));

      expect(onRename).toHaveBeenCalledWith(pngPhoto, "renamed.png");
    });
  });
});
