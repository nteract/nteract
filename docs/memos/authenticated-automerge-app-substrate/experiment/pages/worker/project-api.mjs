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
 * no idempotency key is consumed and a retry with the new names applies once.
 */
import { HttpError } from "./auth.mjs";

/** Old tool name → the tool that replaced it. */
export const RENAMED_TOOLS = Object.freeze({
  create_space: "create_project",
  list_spaces: "list_projects",
  get_space: "get_project",
  update_space: "update_project",
});
const INTERNAL_OPERATION = Object.freeze(
  Object.fromEntries(Object.entries(RENAMED_TOOLS).map(([internal, api]) => [api, internal])),
);
/** Results that can carry a Project or placement. Other bodies pass through. */
const MAPPED_RESULTS = new Set([
  ...Object.values(RENAMED_TOOLS),
  "create_page",
  "list_pages",
  "read_page",
  "delete_page",
  "restore_page",
  "purge_page",
]);

export const renamedTool = (name) =>
  new HttpError(400, `\`${name}\` was renamed \`${RENAMED_TOOLS[name]}\``, "tool_renamed");

const renameKey = (value, from, to) =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key === from ? to : key, item]));

/** An API call as the internal operation and arguments it runs as. */
export function toInternalCall(operation, args) {
  if (Object.hasOwn(RENAMED_TOOLS, operation)) throw renamedTool(operation);
  let internalArgs = args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    if (Object.hasOwn(args, "space_id"))
      throw new HttpError(400, "`space_id` is now `project_id`", "argument_renamed");
    if (Object.hasOwn(args, "project_id")) internalArgs = renameKey(args, "project_id", "space_id");
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

/** Run an API call through `invoke`, which speaks the internal names. */
export async function invokeProjectApi(invoke, operation, args) {
  const call = toInternalCall(operation, args);
  const response = await invoke(call.operation, call.args);
  if (!MAPPED_RESULTS.has(operation)) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const body = toProjectBody(operation, JSON.parse(await response.text()));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
