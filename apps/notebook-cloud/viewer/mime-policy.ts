import { DEFAULT_PRIORITY } from "@/components/outputs/mime-priority";

const WIDGET_VIEW_MIME = "application/vnd.jupyter.widget-view+json";

/**
 * The published cloud viewer does not hydrate RuntimeStateDoc widget models
 * yet. Prefer a widget output's text/plain fallback when it exists, while
 * keeping every other shared nteract MIME priority unchanged.
 */
export const CLOUD_VIEWER_PRIORITY = DEFAULT_PRIORITY.filter(
  (mimeType) => mimeType !== WIDGET_VIEW_MIME,
);
