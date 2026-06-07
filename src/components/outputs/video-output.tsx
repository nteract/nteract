import { cn } from "@/lib/utils";
import { mediaDataToSource } from "./media-url";

interface VideoOutputProps {
  /**
   * Video data — blob URL, data URL, or base64-encoded string
   */
  data: string;
  /**
   * The media type of the video (e.g. "video/mp4", "video/webm")
   */
  mediaType?: string;
  /**
   * Optional width constraint
   */
  width?: number;
  /**
   * Optional height constraint
   */
  height?: number;
  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * Renders a video player for notebook outputs.
 * Handles blob URLs from the blob store, data URLs, and base64-encoded video.
 */
export function VideoOutput({
  data,
  mediaType = "video/mp4",
  width,
  height,
  className = "",
}: VideoOutputProps) {
  if (!data) return null;

  const src = mediaDataToSource(data, mediaType);

  const sizeProps: { width?: number; height?: number } = {};
  if (width) sizeProps.width = width;
  if (height) sizeProps.height = height;

  return (
    <div data-slot="video-output" className={cn("py-2", className)}>
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        className="block max-w-full h-auto"
        {...sizeProps}
      />
    </div>
  );
}
