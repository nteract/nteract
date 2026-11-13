/**
 * The REST routes beside /mcp and /api/tools: `GET /api/pages` and
 * `PUT|DELETE /api/pages/<id>/tags/<tag>`. Each is a thin wrapper that turns
 * its request into the arguments of an operation the gateway already runs
 * (`invoke`, with `transport: "http-rest"`), so access, validation and the
 * response body are the operation's own.
 */
import { HttpError } from "./auth.mjs";

const invalid = (message) => new HttpError(400, message, "invalid_arguments");

/**
 * The `list_pages` arguments a `GET /api/pages` query string names. The
 * parameters are `list_pages`' own, spelled the same: the route owns no list
 * of them, so an unknown one reaches the argument check and is refused there.
 *
 * Only the typing a query string loses is restored: `limit` as a number,
 * `in_trash` and `include_tags` as booleans, and `parent_id=null` as null (no
 * Page ID spells `null`). A value that does not coerce is passed on as the
 * string it is, so `list_pages` refuses it with its own message. A repeated
 * parameter is refused rather than guessing which one was meant.
 */
export function listArguments(searchParams) {
  const args = {};
  for (const [name, value] of searchParams) {
    if (Object.hasOwn(args, name))
      throw invalid(`\`${name.slice(0, 64)}\` was sent more than once`);
    args[name] = coerce(name, value);
  }
  return args;
}

function coerce(name, value) {
  if (name === "limit" && /^[0-9]{1,15}$/.test(value)) return Number(value);
  if ((name === "in_trash" || name === "include_tags") && (value === "true" || value === "false"))
    return value === "true";
  if (name === "parent_id" && value === "null") return null;
  return value;
}

/** The tag a `/tags/<tag>` path segment names: percent-decoded once. */
export function tagFromSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "tag: not a valid percent-encoded tag", "invalid_tag");
  }
}
