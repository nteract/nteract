import { cn } from "@/lib/utils";
import { mediaDataToSource } from "./media-url";

interface AudioOutputProps {
  /**
   * Audio data — blob URL, data URL, or base64-encoded string
   */
  data: string;
  /**
   * The media type of the audio (e.g. "audio/wav", "audio/mpeg")
   */
  mediaType?: string;
  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * Renders an audio player for notebook outputs.
 * Handles blob URLs from the blob store, data URLs, and base64-encoded audio.
 */
export function AudioOutput({ data, mediaType = "audio/wav", className = "" }: AudioOutputProps) {
  if (!data) return null;

  const src = mediaDataToSource(data, mediaType);

  return (
    <div data-slot="audio-output" className={cn("py-2", className)}>
      <audio src={src} controls preload="metadata" />
    </div>
  );
}
