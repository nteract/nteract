import { DEFAULT_PRIORITY } from "@/components/outputs/mime-priority";

/**
 * Keep cloud output selection aligned with the shared notebook renderer.
 * Cloud hydrates RuntimeStateDoc widget models before rendering, so widget
 * views should win over stale text fallbacks just like desktop.
 */
export const CLOUD_VIEWER_PRIORITY = DEFAULT_PRIORITY;
