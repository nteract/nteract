/**
 * The argument names each public operation takes, checked at the public
 * boundary, /mcp, /api/tools and the REST routes (rest-api.mjs), once the credential may make the call and
 * before anything runs. An argument whose name isn't one of them is refused with 400
 * `invalid_arguments`, naming it, so a misspelled or retired guard never
 * turns into a write without its guard. Arguments the hosts add after the
 * boundary (host-to-host calls) are not checked here.
 *
 * An MCP tool takes the properties of its input schema (mcp.mjs). /api/tools
 * takes the same, plus API_ARGUMENTS for the operations the viewer and
 * scripts call there. The REST routes take the same schema, plus REST_ARGUMENTS
 * for the operations only they call. An operation with none takes no arguments.
 */
import { tools } from "../mcp.mjs";
import { HttpError } from "./auth.mjs";

const SCHEMA_ARGUMENTS = new Map(
  tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]),
);

/**
 * delete_page's browser guard. A browser holds Automerge heads, never a
 * revision handle, so a browser session (cookie-authenticated, credential
 * kind "oidc") names the heads of the document it shows as `base_heads`,
 * and a Page a peer edited since refuses the Trash with `stale_revision`.
 * Any other credential that sends `base_heads` is refused with
 * `invalid_arguments`; an agent names a `revision`.
 */
export const BROWSER_TRASH_GUARD = "base_heads";
const browserSession = (identity) => identity?.credentialKind === "oidc";

/** /api/tools arguments beyond the MCP schema, by operation. */
export const API_ARGUMENTS = Object.freeze({
  // The library grid's cards. No MCP tool describes it.
  page_cards: ["page_ids"],
  // A reply by thread_id; manage_page_comment's reply action takes the same.
  reply_page_comment: [
    "page_id",
    "project_id",
    "thread_id",
    "body",
    "body_format",
    "revision",
    "nonce",
  ],
  // The browser names the account that opened the Page; another signed-in
  // account is refused before anything changes.
  delete_page: ["expected_principal", BROWSER_TRASH_GUARD],
  restore_page: ["expected_principal"],
  purge_page: ["expected_principal"],
});

/** Arguments of the operations only the REST routes call. */
export const REST_ARGUMENTS = Object.freeze({
  put_page_tag: ["page_id", "tag"],
  delete_page_tag: ["page_id", "tag"],
});

/** The argument names `operation` takes over `transport` ("mcp",
 * "http-tools" or "http-rest") from `identity`. `GET /api/pages` takes
 * `list_pages`' schema, like MCP. */
export function allowedArguments(operation, transport, identity) {
  const names = new Set(SCHEMA_ARGUMENTS.get(operation) ?? []);
  if (transport === "http-tools")
    for (const name of API_ARGUMENTS[operation] ?? []) names.add(name);
  if (transport === "http-rest")
    for (const name of REST_ARGUMENTS[operation] ?? []) names.add(name);
  if (operation === "delete_page" && !browserSession(identity)) names.delete(BROWSER_TRASH_GUARD);
  return names;
}

/** Refuse a public call that names an argument its operation doesn't take. */
export function checkArguments({ transport, operation, args }, identity) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const allowed = allowedArguments(operation, transport, identity);
  for (const name of Object.keys(args))
    if (!allowed.has(name))
      throw new HttpError(
        400,
        `${operation} has no argument \`${name.slice(0, 64)}\``,
        "invalid_arguments",
      );
}
