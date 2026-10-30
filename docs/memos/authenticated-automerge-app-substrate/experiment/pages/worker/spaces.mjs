/**
 * Spaces: containers for Pages.
 *
 * A Space has its own prefixed ID (`sp_<uuid>`), title, description, owner,
 * a members ACL with a revision, and a home Page created with it. The Space
 * Durable Object is the authority for that record. Membership is owner-only
 * in this build: `members` stays empty, nothing inherits access from a Space,
 * and a Space's Pages are readable by its owner plus anyone holding a direct
 * grant on a Page.
 *
 * Pages carry their placement in the Page record (`metadata.placement`):
 * `space_id` (null for Your items), `parent_id` (null at the top level),
 * `position` among siblings, `placement_epoch` and `home`. The owner's Catalog
 * entries copy it at creation. Placement only changes when a restore returns
 * a Page whose parent is gone to the top level, which bumps the epoch.
 */
import { HttpError, authenticate, json, readJson, requireWrite, errorResponse } from "./auth.mjs";
import { fingerprint, mutationKey } from "./mutations.mjs";
import { validPageId } from "./registration.mjs";
import { NO_ACTOR_CHAIN, decide, heldRelation, principalOf, projectObject } from "./authz.mjs";

export const SPACE_LIMIT = 50;
/** Deepest allowed nesting; a top-level Page is at depth 1. */
export const MAX_DEPTH = 8;
export const SPACE_TITLE_LIMIT = 200;
export const SPACE_DESCRIPTION_LIMIT = 2000;
const RECEIPT_LIMIT = 64;
const RECORD = "space/record";
const receiptKey = (operationKey) => `host/receipt/${operationKey.slice("host/operation/".length)}`;

const spaceIdPattern = /^sp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validSpaceId = (id) => typeof id === "string" && spaceIdPattern.test(id);
export const newSpaceId = () => `sp_${crypto.randomUUID()}`;

/** Space and Page IDs have different shapes, so a mix-up is a structural
 * error that reveals nothing about either resource. The message names the
 * argument and tool that take the ID the caller actually has.
 */
export function requirePageIdArgument(value, argument = "page_id") {
  if (validPageId(value)) return value;
  if (validSpaceId(value))
    throw new HttpError(
      400,
      argument === "parent_id"
        ? "parent_id expects a Page ID, but this is a Space ID. Pass it as space_id to create or list Pages at the Space's top level."
        : `${argument} expects a Page ID, but this is a Space ID. Use get_space with space_id to read a Space; its home_page_id is a Page ID for read_page.`,
      "space_id_as_page_id",
    );
  throw new HttpError(400, `Invalid ${argument}`);
}
export function requireSpaceIdArgument(value, argument = "space_id") {
  if (validSpaceId(value)) return value;
  if (validPageId(value))
    throw new HttpError(
      400,
      `${argument} expects a Space ID (sp_…), but this is a Page ID. Use read_page with page_id, or pass it as parent_id to nest a Page under it.`,
      "page_id_as_space_id",
    );
  throw new HttpError(400, `Invalid ${argument}`);
}
export const spaceNotFound = () => new HttpError(404, "Space not found", "space_not_found");

function optionalText(value, name, limit, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > limit)
    throw new HttpError(400, `${name} must be a string of at most ${limit} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new HttpError(400, `${name} contains control characters`);
  return value;
}
export function validateSpaceInput(args, { creating }) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Invalid Space arguments");
  const title = optionalText(args.title, "title", SPACE_TITLE_LIMIT, { required: creating });
  if (title !== undefined && !title.trim()) throw new HttpError(400, "title is required");
  const description = optionalText(args.description, "description", SPACE_DESCRIPTION_LIMIT);
  if (!creating) {
    requireSpaceIdArgument(args.space_id);
    if (title === undefined && description === undefined)
      throw new HttpError(400, "Provide title or description to update");
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0)
      throw new HttpError(400, "expected_revision is required: pass revision from get_space");
  }
  return { title: title?.trim(), description };
}

/** Body of a new home Page. It is ordinary Page content: guidance for people
 * and agents, never authority to widen a task. */
export function homePageMarkdown(description) {
  const lead = description?.trim() ? description.trim() : "Describe what this Space is for.";
  return `${lead}\n\n## Guidance\n\nThis is the Space's home Page. Keep current priorities and notes for people and agents working in this Space here.`;
}

/** A Page record's placement, or Your items at the top level. */
export function pagePlacement(metadata) {
  const placement = metadata?.placement;
  return {
    space_id: placement?.space_id ?? null,
    parent_id: placement?.parent_id ?? null,
    position: placement?.position ?? null,
    placement_epoch: placement?.placement_epoch ?? 0,
    home: placement?.home === true,
  };
}
/** Placement fields copied into the owner's Catalog entries. */
export function placementEntry(placement) {
  if (!placement) return {};
  return {
    space_id: placement.space_id ?? null,
    parent_id: placement.parent_id ?? null,
    position: placement.position ?? null,
    placement_epoch: placement.placement_epoch ?? 0,
    ...(placement.home && { home: true }),
  };
}
/** The same view over a Catalog entry. Entries from before Spaces have none. */
export const entryPlacement = (entry) => pagePlacement({ placement: entry });

/** Shape check for a placement the host supplies on creation or restore. */
export function validatePlacement(placement) {
  if (
    !placement ||
    typeof placement !== "object" ||
    Array.isArray(placement) ||
    !(placement.space_id === null || validSpaceId(placement.space_id)) ||
    !(placement.parent_id === null || validPageId(placement.parent_id)) ||
    typeof placement.position !== "string" ||
    !/^[0-9A-Za-z]{1,64}$/.test(placement.position) ||
    !Number.isSafeInteger(placement.placement_epoch) ||
    placement.placement_epoch < 0 ||
    (placement.home !== undefined && placement.home !== true) ||
    (placement.home && (placement.space_id === null || placement.parent_id !== null))
  )
    throw new HttpError(400, "Invalid placement");
  return {
    space_id: placement.space_id,
    parent_id: placement.parent_id,
    position: placement.position,
    placement_epoch: placement.placement_epoch,
    ...(placement.home && { home: true }),
  };
}

export function publicSpace(record) {
  return {
    space_id: record.space_id,
    title: record.title,
    description: record.description ?? "",
    home_page_id: record.home_page_id,
    role: "owner",
    revision: record.revision ?? 0,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Owner-only in this build: projectObject lists the owner as the only
 * relation. The next slice adds members and their roles. */
function can(capability, record, identity) {
  return decide(
    principalOf(identity),
    NO_ACTOR_CHAIN,
    projectObject(record),
    Date.now(),
  ).capabilities.includes(capability);
}

/** Authority for one Space's record and ACL. Only the host reaches these
 * routes: the gateway forwards Space operations through the caller's Catalog,
 * which calls the Space with the caller's own credentials. A Space never
 * calls a Catalog or a Page. */
export class Space {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.tail = Promise.resolve();
  }
  fetch(request) {
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return next;
  }
  async run(request) {
    try {
      const path = new URL(request.url).pathname;
      const identity = await authenticate(request, this.env);
      const args = await readJson(request);
      requireSpaceIdArgument(args?.space_id);
      if (this.ctx.id?.name && this.ctx.id.name !== args.space_id) throw spaceNotFound();
      const record = await this.ctx.storage.get(RECORD);
      if (path === "/internal/space/create") return await this.create(identity, args, record);
      // A Space the caller cannot read looks exactly like a missing one.
      if (!record || !can("read", record, identity)) throw spaceNotFound();
      if (path === "/internal/space/read") return json(publicSpace(record));
      if (path === "/internal/space/update") return await this.update(identity, args, record);
      throw new HttpError(404, "Not found");
    } catch (error) {
      return errorResponse(error, "space");
    }
  }

  /** Idempotent: the owner's Catalog repeats this after a lost response or a
   * crash, with the same Space ID and home Page ID. */
  async create(identity, args, record) {
    requireWrite(identity);
    const { title, description } = validateSpaceInput(args, { creating: true });
    if (!validPageId(args.home_page_id)) throw new HttpError(400, "Invalid home_page_id");
    if (record) {
      if (heldRelation(projectObject(record), identity.principal) !== "owner")
        throw spaceNotFound();
      if (record.home_page_id !== args.home_page_id)
        throw new HttpError(409, "Space already exists");
      return json(publicSpace(record));
    }
    const now = new Date().toISOString();
    const created = {
      space_id: args.space_id,
      title,
      description: description ?? "",
      owner: identity.principal,
      owner_name: identity.displayName,
      // Owner-only membership. Members gain roles and generations later.
      acl: { revision: 0, members: {} },
      home_page_id: args.home_page_id,
      revision: 0,
      created_at: now,
      updated_at: now,
    };
    await this.ctx.storage.put(RECORD, created);
    await this.ctx.storage.sync();
    return json(publicSpace(created), 201);
  }

  async update(identity, args, record) {
    requireWrite(identity);
    const { title, description } = validateSpaceInput(args, { creating: false });
    const key = mutationKey(args);
    const digest = await fingerprint(
      "update_space",
      { space_id: args.space_id, title, description, expected_revision: args.expected_revision },
      identity,
    );
    const recorded = await this.ctx.storage.get(receiptKey(key));
    if (recorded) {
      if (recorded.fingerprint !== digest)
        throw new HttpError(409, "idempotency_key was used for a different request");
      return json(recorded.receipt);
    }
    // The fence: a request applies only at the revision its caller read.
    if (args.expected_revision !== record.revision)
      throw new HttpError(
        409,
        "Space changed; get_space again and retry with its revision",
        "space_revision_conflict",
      );
    const next = {
      ...record,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      revision: record.revision + 1,
      updated_at: new Date().toISOString(),
    };
    const receipt = publicSpace(next);
    await this.ctx.storage.put({
      [RECORD]: next,
      [receiptKey(key)]: { fingerprint: digest, receipt, at: Date.now() },
    });
    await this.ctx.storage.sync();
    const receipts = await this.ctx.storage.list({ prefix: "host/receipt/" });
    if (receipts.size > RECEIPT_LIMIT)
      for (const [name] of [...receipts]
        .sort(([, a], [, b]) => a.at - b.at)
        .slice(0, receipts.size - RECEIPT_LIMIT))
        await this.ctx.storage.delete(name);
    return json(receipt);
  }
}
