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
 * The owner's Catalog records where each Page is (catalog-location.mjs), with
 * the nesting limit from model/location.mjs. Page records carry no location.
 *
 * Callers see Projects; project-api.mjs maps the API onto this module.
 * Storage keeps the Space name so a rollback build reads the same records.
 * That covers the `space/record` key, `space_id` fields, stored receipts and
 * the `Space` class behind the `PROJECTS` binding. Messages and error codes
 * are not stored, so they use the Project name.
 */
import { HttpError, authenticate, json, readJson, requireWrite, errorResponse } from "./auth.mjs";
import { fingerprint, mutationKey } from "./mutations.mjs";
import { validPageId } from "./registration.mjs";
import { NO_ACTOR_CHAIN, decide, heldRelation, principalOf, projectObject } from "./authz.mjs";
import { serialQueue } from "./serial-queue.mjs";

export const SPACE_LIMIT = 50;
export const SPACE_TITLE_LIMIT = 200;
export const SPACE_DESCRIPTION_LIMIT = 2000;
const RECEIPT_LIMIT = 64;
const RECORD = "space/record";
const receiptKey = (operationKey) => `host/receipt/${operationKey.slice("host/operation/".length)}`;

/** New Projects get `prj_` IDs. `sp_` IDs were minted before Projects had
 * their name and stay valid. IDs are not storage keys' names, so either shape
 * is stored under `space/<id>`. */
const spaceIdPattern =
  /^(prj|sp)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validSpaceId = (id) => typeof id === "string" && spaceIdPattern.test(id);
export const newSpaceId = () => `prj_${crypto.randomUUID()}`;

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
        ? "parent_id expects a Page ID, but this is a Project ID. Pass it as project_id to create or list Pages at the Project's top level."
        : `${argument} expects a Page ID, but this is a Project ID. Use get_project with project_id to read a Project; its home_page_id is a Page ID for read_page.`,
      "project_id_as_page_id",
    );
  throw new HttpError(400, `Invalid ${argument}`, "invalid_page_id");
}
export function requireSpaceIdArgument(value, argument = "project_id") {
  if (validSpaceId(value)) return value;
  if (validPageId(value))
    throw new HttpError(
      400,
      `${argument} expects a Project ID (prj_…), but this is a Page ID. Use read_page with page_id, or pass it as parent_id to nest a Page under it.`,
      "page_id_as_project_id",
    );
  throw new HttpError(400, `Invalid ${argument}`);
}
export const spaceNotFound = () => new HttpError(404, "Project not found", "project_not_found");

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
    throw new HttpError(400, "Invalid Project arguments");
  const title = optionalText(args.title, "title", SPACE_TITLE_LIMIT, { required: creating });
  if (title !== undefined && !title.trim()) throw new HttpError(400, "title is required");
  const description = optionalText(args.description, "description", SPACE_DESCRIPTION_LIMIT);
  if (!creating) {
    requireSpaceIdArgument(args.space_id);
    if (title === undefined && description === undefined)
      throw new HttpError(400, "Provide title or description to update");
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0)
      throw new HttpError(400, "expected_revision is required: pass revision from get_project");
  }
  return { title: title?.trim(), description };
}

/** Body of a new home Page. It is ordinary Page content: guidance for people
 * and agents, never authority to widen a task. */
export function homePageMarkdown(description) {
  const lead = description?.trim() ? description.trim() : "Describe what this Project is for.";
  return `${lead}\n\n## Guidance\n\nThis is the Project's home Page. Keep current priorities and notes for people and agents working in this Project here.`;
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

/** Authority for one Project's record and ACL. Only the host reaches these
 * routes: the gateway forwards Project operations through the caller's
 * Catalog, which calls this object with the caller's own credentials. It never
 * calls a Catalog or a Page.
 *
 * The class name is the storage identity for Projects: celld keys Durable
 * Object storage by class name and refuses `renamed_classes` migrations, so
 * the class stays `Space` behind the `PROJECTS` binding. */
export class Space {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = serialQueue(ctx, "space-queue");
  }
  fetch(request) {
    return this.queue(() => this.run(request));
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
        throw new HttpError(409, "Project already exists");
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
        throw new HttpError(
          409,
          "idempotency_key was used for a different request",
          "idempotency_conflict",
        );
      return json(recorded.receipt);
    }
    // The fence: a request applies only at the revision its caller read.
    if (args.expected_revision !== record.revision)
      throw new HttpError(
        409,
        "Project changed; get_project again and retry with its revision",
        "project_revision_conflict",
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
