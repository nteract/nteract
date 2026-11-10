/**
 * create_page in a Project another account owns.
 *
 * Every Page in a Project is an entry in the Project owner's Catalog, owned by
 * the Project owner (project-access.mjs relies on it). A Project editor's
 * create_page therefore lands in the owner's Catalog: the new Page is owned by
 * the Project owner, takes a slot of the owner's Page limit, and records the
 * editor as its `creator`.
 *
 * Two Catalogs take part:
 *
 * - The caller's Catalog resolves the target (the Project and its owner),
 *   decides `create_items` against the Project's ACL, and keeps a forwarding
 *   record under the caller's own idempotency key. The record names a
 *   `forward_id` and the target, so a retry resumes the same creation in the
 *   owner's Catalog instead of starting a second one. Its states are below.
 * - The owner's Catalog receives the forward on PROJECT_CREATE_PATH. For a new
 *   forward it checks the ACL revision fence the caller decided at, decides
 *   `create_items` itself, applies its owner's Page limit, and reserves an
 *   intent keyed by the forward_id, with the pending `page/` entry naming the
 *   creator. A forward it already reserved resumes or replays; the
 *   reservation was the authorized moment.
 *
 * The Page host accepts an owner other than the authenticated caller only when
 * the owner's Catalog holds a pending entry for that Page whose creator is
 * the caller (Page `requireDelegatedCreation`).
 *
 * The caller's forwarding record:
 *
 *   absent --request--> authorizing --authorized--> forwarding (reserve)
 *   authorizing --denied--> absent (reply)
 *   forwarding --request--> forwarding (fence)        a stored record resumes
 *   forwarding --reserved | fenced--> forwarding (forward)
 *   forwarding --created--> completed (complete)
 *   forwarding --refused--> absent (release)          refused before an intent
 *   forwarding --fence_moved--> forwarding (fence)    the ACL moved; re-read it
 *   forwarding --fence_exhausted--> absent (release)  it kept moving
 *   forwarding --failed--> forwarding (reply)         the owner may hold an intent
 *   completed --request--> completed (replay)
 *
 * `authorizing` is never stored. `forwarding` and `completed` are the record's
 * `pending: true` and `pending: false`.
 */
import { HttpError } from "./auth.mjs";
import { NO_ACTOR_CHAIN, decide, heldRelation, principalOf, projectObject } from "./authz.mjs";
import { pageCount } from "./page-quota.mjs";

/** The owner Catalog's host-only route for a forwarded create_page. */
export const PROJECT_CREATE_PATH = "/internal/project-create";

/** The owner Catalog's answer header for a forward it refused before
 * reserving anything. The caller's Catalog may then forget its record. */
export const FORWARD_REJECTED_HEADER = "x-pages-forward-rejected";

/** How many times one request re-reads a moved ACL revision before it gives up. */
export const FENCE_ATTEMPTS = 3;

export const FORWARDED_CREATION_STATES = Object.freeze([
  "absent",
  "authorizing",
  "forwarding",
  "completed",
]);
export const FORWARDED_CREATION_EVENTS = Object.freeze([
  "request",
  "authorized",
  "denied",
  "reserved",
  "fenced",
  "created",
  "refused",
  "fence_moved",
  "fence_exhausted",
  "failed",
]);

const table = Object.freeze({
  absent: { request: ["authorizing", "resolve"] },
  authorizing: { authorized: ["forwarding", "reserve"], denied: ["absent", "reply"] },
  forwarding: {
    request: ["forwarding", "fence"],
    reserved: ["forwarding", "forward"],
    fenced: ["forwarding", "forward"],
    created: ["completed", "complete"],
    refused: ["absent", "release"],
    fence_moved: ["forwarding", "fence"],
    fence_exhausted: ["absent", "release"],
    failed: ["forwarding", "reply"],
  },
  completed: { request: ["completed", "replay"] },
});

/** `(state, event) -> { state, effect }`. An event that does not apply to the
 * state is a programming error, never a silent no-op. */
export function forwardedCreationTransition(state, event) {
  const next = table[state]?.[event];
  if (!next) throw new Error(`A forwarded creation cannot take ${event} in ${state}`);
  return { state: next[0], effect: next[1] };
}

/** The state a stored forwarding record is in. */
export const forwardedCreationState = (record) =>
  !record ? "absent" : record.pending ? "forwarding" : "completed";

/** The owner Catalog's journal key for a forward. Client keys never hold `:`. */
export const forwardKey = (forwardId) => `host/operation/forward:${forwardId}`;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validForwardId = (value) => typeof value === "string" && uuidPattern.test(value);

/** Whether `identity` may add Pages to the Project `record` (a Project
 * policy snapshot), and the role it holds there. */
export function createItemsDecision(record, identity, now = Date.now()) {
  const object = projectObject(record);
  return {
    allowed: decide(principalOf(identity), NO_ACTOR_CHAIN, object, now).capabilities.includes(
      "create_items",
    ),
    role: heldRelation(object, identity.principal),
  };
}

/** Refuse a caller who may not add Pages to the Project. A member without
 * create_items learns why; anyone else sees `notFound()`, as for a Project
 * they can't open. */
export function requireCreateItems(record, identity, notFound, now = Date.now()) {
  const { allowed, role } = createItemsDecision(record, identity, now);
  if (allowed) return;
  if (["viewer", "commenter", "editor", "owner"].includes(role))
    throw new HttpError(
      403,
      `Only a Project's owner and editors can add Pages to it; your role in this Project is ${role}.`,
      "project_create_forbidden",
    );
  throw notFound();
}

/** The refusal when the Project owner's Catalog is at its Page limit. A Page
 * added to a Project counts against its owner's limit, never the creator's. */
export function projectOwnerQuotaError(limit) {
  return Object.assign(
    new HttpError(
      409,
      limit === 0
        ? "This Project's owner can't create Pages right now, and Pages added to a Project count against its owner's limit. Ask the owner."
        : `This Project's owner has reached their limit of ${pageCount(limit)}. Pages added to a Project count against its owner's limit; ask the owner to free space.`,
      "project_owner_quota_exceeded",
    ),
    { details: { limit } },
  );
}

/** The ACL revision moved between the caller's decision and the owner's. */
export const fenceMoved = () =>
  new HttpError(
    409,
    "The Project's sharing changed while this Page was being added; retry",
    "project_access_changed",
  );

/** How the caller's Catalog reads the owner Catalog's answer: the event it
 * feeds the machine. `fences` counts the revisions this request has sent. */
export function forwardAnswer(response, body, fences = 1) {
  if (response.ok) return { type: "created", receipt: body };
  const before =
    response.headers.get(FORWARD_REJECTED_HEADER) === "before-intent" ||
    response.headers.get("x-pages-create-rejected") === "before-intent";
  if (before && body?.code === "project_access_changed")
    return { type: fences >= FENCE_ATTEMPTS ? "fence_exhausted" : "fence_moved" };
  if (before) return { type: "refused" };
  return { type: "failed" };
}
