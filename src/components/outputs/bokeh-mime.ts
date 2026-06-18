export const BOKEHJS_LOAD_MIME_TYPE = "application/vnd.bokehjs_load.v0+json";
export const BOKEHJS_EXEC_MIME_TYPE = "application/vnd.bokehjs_exec.v0+json";

const BOKEH_MIME_TYPES = new Set([BOKEHJS_LOAD_MIME_TYPE, BOKEHJS_EXEC_MIME_TYPE]);

export function isBokehMimeType(mimeType: string): boolean {
  return BOKEH_MIME_TYPES.has(mimeType);
}
