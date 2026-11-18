import { OUTPUT_FRAME_PATH } from "./output-frame-paths.mjs";

export const ANYWIDGET_MEDIA_TYPE = "application/vnd.nteract.anywidget.v2+json";
export const MODULE_MEDIA_TYPE = "application/vnd.nteract.module-view.v1+json";
export const isExecutableView = (type) =>
  type === ANYWIDGET_MEDIA_TYPE || type === MODULE_MEDIA_TYPE;
export const ESM_MEDIA_TYPE = "text/javascript";
export const CSS_MEDIA_TYPE = "text/css";
export const BINARY_MEDIA_TYPE = "application/octet-stream";
export const WAV_MEDIA_TYPE = "audio/wav";
export const OUTPUT_ASSET_TYPES = [
  ESM_MEDIA_TYPE,
  CSS_MEDIA_TYPE,
  BINARY_MEDIA_TYPE,
  WAV_MEDIA_TYPE,
];
export const OUTPUT_FRAME_URL = `https://pages.kilousercontent.com${OUTPUT_FRAME_PATH}`;
export const OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
export const OUTPUT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
