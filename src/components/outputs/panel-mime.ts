import { NTERACT_PANEL_RUNTIME_MIME_TYPE } from "runtimed";

export { NTERACT_PANEL_RUNTIME_MIME_TYPE };
export const PANEL_LOAD_MIME_TYPE = "application/vnd.holoviews_load.v0+json";
export const PANEL_EXEC_MIME_TYPE = "application/vnd.holoviews_exec.v0+json";

const PANEL_MIME_TYPES = new Set([
  NTERACT_PANEL_RUNTIME_MIME_TYPE,
  PANEL_LOAD_MIME_TYPE,
  PANEL_EXEC_MIME_TYPE,
]);

export function isPanelMimeType(mimeType: string): boolean {
  return PANEL_MIME_TYPES.has(mimeType);
}
