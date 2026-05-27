import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "./ui/button";

export type ImageViewerItem = {
  bytes: Uint8Array;
  mime: string;
  sourceIndex: number;
};

export type ImageViewerHandle = {
  unmount(): void;
};

type ImageViewerProps = {
  items: ImageViewerItem[];
  initialIndex: number;
  columnLabel: string;
  onClose: () => void;
};

function createImageObjectUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes.slice() as Uint8Array<ArrayBuffer>], { type: mime }));
}

function formatMeta(columnLabel: string, index: number, total: number, dimensions: string | null) {
  const position = `Image ${index + 1} of ${total}`;
  const parts = /^images?$/i.test(columnLabel) ? [position] : [columnLabel, position];
  if (dimensions) parts.push(dimensions);
  return parts.join(" - ");
}

function ImageViewer({ items, initialIndex, columnLabel, onClose }: ImageViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const item = items[currentIndex];
  const hasMultiple = items.length > 1;
  const meta = formatMeta(columnLabel, currentIndex, items.length, dimensions);

  useEffect(() => {
    const url = createImageObjectUrl(item.bytes, item.mime);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item]);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  function navigate(delta: number) {
    setDimensions(null);
    setObjectUrl(null);
    setCurrentIndex((index) => (index + delta + items.length) % items.length);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          if (hasMultiple) {
            e.preventDefault();
            navigate(-1);
          }
          break;
        case "ArrowRight":
          if (hasMultiple) {
            e.preventDefault();
            navigate(1);
          }
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasMultiple, items.length, onClose]);

  return (
    <>
      <div className="sift-image-viewer-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        className="sift-image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`${columnLabel} viewer, ${meta}`}
        tabIndex={-1}
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="sift-image-viewer-close"
          aria-label="Close image viewer"
          onClick={onClose}
        >
          <X />
          <span className="sr-only">Close image viewer</span>
        </Button>
        {hasMultiple && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="sift-image-viewer-nav sift-image-viewer-prev"
            aria-label="Previous image"
            onClick={() => navigate(-1)}
          >
            <ChevronLeft />
            <span className="sr-only">Previous image</span>
          </Button>
        )}
        <figure className="sift-image-viewer-frame">
          {objectUrl && (
            <img
              className="sift-image-viewer-img"
              alt={`${columnLabel} image ${currentIndex + 1} of ${items.length}`}
              decoding="async"
              src={objectUrl}
              data-sift-image-viewer-index={item.sourceIndex}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDimensions(
                  img.naturalWidth > 0 && img.naturalHeight > 0
                    ? `${img.naturalWidth} x ${img.naturalHeight}`
                    : null,
                );
              }}
            />
          )}
          <figcaption className="sift-image-viewer-meta">{meta}</figcaption>
        </figure>
        {hasMultiple && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="sift-image-viewer-nav sift-image-viewer-next"
            aria-label="Next image"
            onClick={() => navigate(1)}
          >
            <ChevronRight />
            <span className="sr-only">Next image</span>
          </Button>
        )}
      </div>
    </>
  );
}

export function mountImageViewer(props: Omit<ImageViewerProps, "onClose">): ImageViewerHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let closed = false;
  let handle: ImageViewerHandle;

  function close() {
    handle.unmount();
  }

  handle = {
    unmount() {
      if (closed) return;
      closed = true;
      root.unmount();
      container.remove();
    },
  };

  root.render(createElement(ImageViewer, { ...props, onClose: close }));
  return handle;
}
