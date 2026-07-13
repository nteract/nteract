export const BOKEHJS_LOAD_MIME_TYPE = "application/vnd.bokehjs_load.v0+json";
export const BOKEHJS_EXEC_MIME_TYPE = "application/vnd.bokehjs_exec.v0+json";
export const NTERACT_BOKEH_SESSION_MIME_TYPE = "application/vnd.nteract.bokeh-session.v1+json";

const BOKEH_MIME_TYPES = new Set([BOKEHJS_LOAD_MIME_TYPE, BOKEHJS_EXEC_MIME_TYPE]);

export function isBokehMimeType(mimeType: string): boolean {
  return BOKEH_MIME_TYPES.has(mimeType) || mimeType === NTERACT_BOKEH_SESSION_MIME_TYPE;
}

export function isLegacyBokehMimeType(mimeType: string): boolean {
  return BOKEH_MIME_TYPES.has(mimeType);
}

export interface BokehSessionResourceUrl {
  kind: "url";
  url: string;
  integrity?: string;
}

export interface BokehSessionResourceInline {
  kind: "inline";
  code: string;
}

export interface BokehSessionModuleResource {
  kind: "module";
  url: string;
}

export interface BokehSessionResources {
  javascript: Array<BokehSessionResourceUrl | BokehSessionResourceInline>;
  stylesheets: Array<BokehSessionResourceUrl | BokehSessionResourceInline>;
  javascript_modules: BokehSessionModuleResource[];
  module_exports: Record<string, string>;
}

export interface BokehSessionInitialBufferRef {
  id: string;
  blob?: string;
  size: number;
  media_type?: string;
  hash?: string;
  buffer_index?: number;
}

export interface BokehSessionMimePayload {
  schema_version: 1;
  session_id: string;
  revision: number;
  producer: {
    name: string;
    version: string;
  };
  bokeh_version: string;
  document: Record<string, unknown>;
  root_ids: string[];
  resources: BokehSessionResources;
  buffers: BokehSessionInitialBufferRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBokehSessionMimePayload(value: unknown): value is BokehSessionMimePayload {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  if (typeof value.session_id !== "string" || value.session_id.length === 0) return false;
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)) return false;
  if (typeof value.bokeh_version !== "string" || value.bokeh_version.length === 0) return false;
  if (!isRecord(value.document) || !isRecord(value.producer) || !isRecord(value.resources)) {
    return false;
  }
  if (!Array.isArray(value.root_ids) || !value.root_ids.every((id) => typeof id === "string")) {
    return false;
  }
  if (!Array.isArray(value.buffers)) return false;
  return (
    typeof value.producer.name === "string" &&
    typeof value.producer.version === "string" &&
    Array.isArray(value.resources.javascript) &&
    Array.isArray(value.resources.stylesheets) &&
    Array.isArray(value.resources.javascript_modules) &&
    isRecord(value.resources.module_exports)
  );
}
