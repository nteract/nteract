/**
 * The Project API over Space storage.
 *
 * Callers see Projects: tool names, `project_id` arguments and results,
 * `kind: "project"` breadcrumbs. Storage, stored intents and receipts, and the
 * internal routes keep the Space name so a rollback build reads the same
 * records, and so an intent a rollback build left pending resumes here as it
 * is. This module is the one place the two names meet: the gateway maps each
 * call in and each result out.
 *
 * Callers that still use the old names are refused before anything runs, so
 * no nonce is consumed and a retry with the new names applies once.
 */
import { pagesPublicOrigin } from "../agent-guide.mjs";
import { pagePath, projectPath } from "../shared/routes.mjs";
import { HttpError } from "./auth.mjs";
import { PROJECT_CONTENT_OPERATIONS } from "./project-content.mjs";

/** Space tool name → the Project tool that runs it. The internal operation
 * keeps the Space name. */
const PROJECT_TOOLS = Object.freeze({
  create_space: "create_project",
  list_spaces: "list_projects",
  get_space: "get_project",
  update_space: "update_project",
});
/** Old tool name → the tool that takes the same arguments now. A call to the
 * old name is refused with the new one, so a client with a cached tool list
 * learns where to go. */
export const RENAMED_TOOLS = Object.freeze({
  ...PROJECT_TOOLS,
  import_page_image: "create_page_asset_upload",
});
const INTERNAL_OPERATION = Object.freeze(
  Object.fromEntries(Object.entries(PROJECT_TOOLS).map(([internal, api]) => [api, internal])),
);
/** Results that can carry a Project or placement. Other bodies pass through. */
const MAPPED_RESULTS = new Set([
  "get_project_access",
  "manage_project_access",
  ...Object.values(PROJECT_TOOLS),
  "delete_project",
  "create_page",
  "list_pages",
  "read_page",
  "delete_page",
  "restore_page",
  "purge_page",
  "move_page",
]);

export const renamedTool = (name) =>
  new HttpError(400, `\`${name}\` was renamed \`${RENAMED_TOOLS[name]}\``, "tool_renamed");

/** The refusal for an operation outside `internalOperations`, listing the
 * valid ones under their API names. */
export function unknownOperation(name, internalOperations) {
  const valid = [...internalOperations].map((operation) => PROJECT_TOOLS[operation] ?? operation);
  const named =
    typeof name === "string" && name
      ? `Unknown operation \`${name.slice(0, 64)}\``
      : "operation is required";
  return new HttpError(400, `${named}. Valid operations: ${valid.join(", ")}`, "unknown_operation");
}

export const invalidArguments = () =>
  new HttpError(400, "arguments must be a JSON object", "invalid_arguments");

const renameKey = (value, from, to) =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key === from ? to : key, item]));

/** An API call as the internal operation and arguments it runs as. */
export function toInternalCall(operation, args) {
  if (Object.hasOwn(RENAMED_TOOLS, operation)) throw renamedTool(operation);
  let internalArgs = args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    if (Object.hasOwn(args, "space_id"))
      throw new HttpError(400, "`space_id` is now `project_id`", "argument_renamed");
    if (Object.hasOwn(args, "project_id") && !PROJECT_CONTENT_OPERATIONS.has(operation))
      internalArgs = renameKey(args, "project_id", "space_id");
  }
  return { operation: INTERNAL_OPERATION[operation] ?? operation, args: internalArgs };
}

const placement = (row) =>
  row && typeof row === "object" && !Array.isArray(row)
    ? renameKey(row, "space_id", "project_id")
    : row;
/** A stored Space record or receipt as a Project. `org` is always null until a
 * host supplies tenancy. */
const project = (space) => {
  const view = placement(space);
  return view && typeof view === "object" ? { ...view, org: view.org ?? null } : view;
};
const breadcrumb = (crumb) =>
  crumb?.kind === "space" ? { ...placement(crumb), kind: "project" } : placement(crumb);

/** An internal result body in the API's names. */
export function toProjectBody(operation, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const projectResult =
    Object.hasOwn(INTERNAL_OPERATION, operation) && operation !== "list_projects";
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "space_id") out.project_id = value;
    else if (key === "space") out.project = project(value);
    else if (key === "spaces" && Array.isArray(value)) out.projects = value.map(project);
    else if (key === "pages" && Array.isArray(value)) out.pages = value.map(placement);
    else if (key === "breadcrumbs" && Array.isArray(value)) out.breadcrumbs = value.map(breadcrumb);
    else out[key] = value;
  }
  if (projectResult && typeof out.project_id === "string") out.org = out.org ?? null;
  return out;
}

/** Browser links for a successful result, the same over JSON and MCP: url for
 * a Page that still exists (a purge receipt carries `deleted`), url for a
 * Project, and url on each listed Page or Project. Project content read with
 * read_page links to its Project. */
export function withBrowserLinks(body, origin) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = { ...body };
  if (out.kind === "project" && out.project_id)
    out.url = new URL(projectPath(out.project_id), origin).href;
  else if (out.page_id && !out.deleted) out.url = new URL(pagePath(out.page_id), origin).href;
  else if (out.project_id && out.document_id)
    out.url = new URL(projectPath(out.project_id), origin).href;
  if (Array.isArray(out.pages))
    out.pages = out.pages.map((page) => ({
      ...page,
      url: new URL(pagePath(page.page_id), origin).href,
    }));
  if (Array.isArray(out.projects))
    out.projects = out.projects.map((entry) => ({
      ...entry,
      url: new URL(projectPath(entry.project_id), origin).href,
    }));
  return out;
}

/** Links from the configured origin; without a valid one, no links. */
function withConfiguredLinks(body, env) {
  try {
    return withBrowserLinks(body, pagesPublicOrigin(env));
  } catch {
    // No configured origin or an unexpected ID: the receipt stands as is.
    return body;
  }
}

/** Codes for refusals the service answered without one, by HTTP status. */
const STATUS_CODES = Object.freeze({
  400: "invalid_request",
  401: "unauthenticated",
  403: "access_denied",
  404: "not_found",
  408: "request_canceled",
  409: "conflict",
  410: "gone",
  413: "request_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
});
/** Every code `refusalCode` can return. */
export const STATUS_FALLBACK_CODES = Object.freeze([
  ...Object.values(STATUS_CODES),
  "server_error",
  "request_refused",
]);

/** The code for a refusal body: its own, or one from its HTTP status. */
export const refusalCode = (status, body) =>
  typeof body?.code === "string" && body.code
    ? body.code
    : (STATUS_CODES[status] ?? (status >= 500 ? "server_error" : "request_refused"));

const isJson = (response) =>
  response.headers.get("content-type")?.includes("application/json") ?? false;

const withBody = (response, body) => {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, headers });
};

/** A JSON refusal with a code, so a JSON caller can branch on it as an MCP
 * caller does. A body that already has one passes through. */
export async function withRefusalCode(response) {
  if (response.ok || !isJson(response)) return response;
  let body;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.code) return response;
  return withBody(response, { ...body, code: refusalCode(response.status, body) });
}

/** Run an API call through `invoke`, which speaks the internal names. With
 * `env`, successful results also carry browser links. */
export async function invokeProjectApi(invoke, operation, args, { env } = {}) {
  const call = toInternalCall(operation, args);
  const response = await invoke(call.operation, call.args);
  const mapped = MAPPED_RESULTS.has(operation);
  const linked = Boolean(env) && response.ok;
  if ((!mapped && !linked) || !isJson(response)) return response;
  let body = JSON.parse(await response.text());
  if (mapped) body = toProjectBody(operation, body);
  if (linked) body = withConfiguredLinks(body, env);
  return withBody(response, body);
}
