/**
 * Spaces: containers for Pages.
 *
 * A Space has its own prefixed ID (`sp_<uuid>`), title, description, owner,
 * a members ACL with a revision, and a home Page created with it. The Space
 * Durable Object is the authority for that record. Members inherit content
 * access to every Page; only the owner manages sharing and structure. Direct
 * Page grants remain independent and never propagate to descendants.
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
import { claimInvitation, proposeSharingMutation } from "./sharing.mjs";
import { indexProjectInvitations } from "./project-invitations.mjs";

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
  return `${lead}\n\n## Guidance\n\nKeep current priorities and notes for people and agents working in this Project here.`;
}

/** Public sharing roster, never durable signing identities or ACL bookkeeping.
 * Accept receipts too so older stored replies cannot expose removed members. */
export function publicProjectAccess(value) {
  const acl = value.acl ?? value;
  return {
    space_id: value.space_id,
    revision: acl.revision ?? 0,
    members: Object.fromEntries(
      Object.entries(acl.members ?? {})
        .filter(([, member]) => ["viewer", "commenter", "editor"].includes(member.role))
        .map(([principal, member]) => [
          principal,
          {
            role: member.role,
            ...(typeof member.displayName === "string" && { displayName: member.displayName }),
            ...(typeof member.email === "string" && { email: member.email }),
          },
        ]),
    ),
    invites: Object.values(acl.invites ?? {}).map(({ id, email, role, expiresAt }) => ({
      id,
      email,
      role,
      expiresAt,
    })),
  };
}

export function publicSpace(record, identity) {
  return {
    space_id: record.space_id,
    title: record.title,
    description: record.description ?? "",
    home_page_id: record.home_page_id,
    role: identity ? heldRelation(projectObject(record), identity.principal) : "owner",
    revision: record.revision ?? 0,
    owner: record.owner,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Capability checks include current Project members. */
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
 * publishes candidate discovery hints to Catalogs; it never calls a Page.
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
    // Read-only host snapshots cannot wait behind a membership operation
    // repairing a recipient's discovery hints (which may check this Project).
    if (new URL(request.url).pathname === "/internal/space/policy") return this.run(request);
    return this.queue(() => this.run(request));
  }
  async run(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/internal/space/policy") {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw spaceNotFound();
        const args = await readJson(request);
        const record = await this.ctx.storage.get(RECORD);
        if (!record || record.space_id !== args.space_id || record.owner !== args.owner)
          throw spaceNotFound();
        await this.ctx.storage.sync();
        return json({ space_id: record.space_id, owner: record.owner, acl: record.acl });
      }
      const identity = await authenticate(request, this.env);
      const args = await readJson(request);
      requireSpaceIdArgument(args?.space_id);
      if (this.ctx.id?.name && this.ctx.id.name !== args.space_id) throw spaceNotFound();
      let record = await this.ctx.storage.get(RECORD);
      // Reads and exact retries confirm the previous output barrier too. A
      // failed ACL write cannot expose or acknowledge an unconfirmed record.
      await this.ctx.storage.sync();
      if (path === "/internal/space/create") return await this.create(identity, args, record);
      if (path === "/internal/space/read" && record) {
        const claimed = await claimInvitation(
          { ...record, pageId: record.space_id },
          identity,
          this.env,
        );
        if (claimed) {
          const discovered = await this.env.CATALOGS.getByName(identity.principal).fetch(
            new Request("https://pages.internal/internal/project-discovery", {
              method: "POST",
              body: JSON.stringify({ space_id: record.space_id, owner: record.owner }),
            }),
          );
          if (!discovered.ok) throw new HttpError(503, "Project discovery unavailable; retry");
          record = { ...record, acl: claimed.acl };
          await this.ctx.storage.put(RECORD, record);
          await this.ctx.storage.sync();
        }
      }
      // A Space the caller cannot read looks exactly like a missing one.
      if (!record || !can("read", record, identity)) throw spaceNotFound();
      if (path === "/internal/space/read") return json(publicSpace(record, identity));
      if (path === "/internal/space/access") {
        if (identity.principal !== record.owner)
          throw new HttpError(403, "Only the Project owner can manage access");
        if (identity.credentialKind === "oauth" && !identity.canShare)
          throw new HttpError(
            403,
            "Pages sharing permission is required",
            "oauth_insufficient_scope",
          );
        if (!args.read) {
          requireWrite(identity);
          if (!["set_role", "invite", "revoke_invite"].includes(args.action))
            throw new HttpError(400, "Choose invite, set_role or revoke_invite");
          if (
            Object.keys(args).some(
              (key) =>
                ![
                  "space_id",
                  "read",
                  "action",
                  "principal",
                  "email",
                  "invite_id",
                  "role",
                  "expected_revision",
                  "idempotency_key",
                ].includes(key),
            )
          )
            throw new HttpError(400, "Unsupported Project sharing argument");
          const key = mutationKey(args);
          const digest = await fingerprint(
            "project_access",
            {
              space_id: args.space_id,
              action: args.action,
              principal: args.principal,
              email: args.email,
              invite_id: args.invite_id,
              role: args.role,
              expected_revision: args.expected_revision,
            },
            identity,
          );
          const previous = await this.ctx.storage.get(receiptKey(key));
          if (previous) {
            if (previous.fingerprint !== digest)
              throw new HttpError(
                409,
                "idempotency_key was used for a different request",
                "idempotency_conflict",
              );
            await this.ctx.storage.sync();
            return json(publicProjectAccess(previous.receipt));
          }
          const proposed = await proposeSharingMutation(
            { ...record, pageId: record.space_id },
            identity,
            args,
          );
          const next = { ...record, acl: proposed.metadata.acl };
          const receipt = publicProjectAccess(next);
          // Discovery is only a candidate hint. Publish before the atomic ACL
          // and receipt; a failed grant may leave a hint but never access.
          if (args.action === "invite") await indexProjectInvitations(this.env, next);
          if (args.action === "set_role" && args.role !== null) {
            const discovered = await this.env.CATALOGS.getByName(args.principal).fetch(
              new Request("https://pages.internal/internal/project-discovery", {
                method: "POST",
                body: JSON.stringify({ space_id: record.space_id, owner: record.owner }),
              }),
            );
            if (!discovered.ok) throw new HttpError(503, "Project discovery unavailable; retry");
          }
          await this.ctx.storage.put({
            [RECORD]: next,
            [receiptKey(key)]: { fingerprint: digest, receipt, at: Date.now() },
          });
          await this.ctx.storage.sync();
          if (args.action === "set_role" && args.role === null)
            await this.env.CATALOGS.getByName(args.principal).fetch(
              new Request("https://pages.internal/internal/project-discovery", {
                method: "POST",
                body: JSON.stringify({ space_id: record.space_id, remove: true }),
              }),
            );
          return json(receipt);
        }
        return json(publicProjectAccess(record));
      }
      if (path === "/internal/space/update") return await this.update(identity, args, record);
      throw new HttpError(404, "Not found");
    } catch (error) {
      // Shared invitation validation uses Page wording internally. Keep this
      // Project endpoint's actionable errors in its own product vocabulary.
      if (error instanceof Error && error.status >= 400 && error.status < 500)
        error.message = error.message.replace(/\bPage\b/g, "Project");
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
      // Membership starts restricted to the owner.
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
    if (identity.principal !== record.owner)
      throw new HttpError(403, "Only the Project owner can update it");
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
