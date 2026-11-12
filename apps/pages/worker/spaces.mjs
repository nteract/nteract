/**
 * Spaces: containers for Pages.
 *
 * A Space has its own prefixed ID (`sp_<uuid>`), title, description, owner,
 * a members ACL with a revision, and one content document created with it
 * (`document_id`, an ordinary Page document outside the Page tree). The Space
 * Durable Object is the authority for that record. Members inherit content
 * access to every Page; editors and the owner add Pages, and only the owner
 * manages sharing and moves or trashes Pages. Direct
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
import { fingerprint, operationKey } from "./mutations.mjs";
import { validPageId } from "./registration.mjs";
import { NO_ACTOR_CHAIN, decide, heldRelation, principalOf, projectObject } from "./authz.mjs";
import { serialQueue } from "./serial-queue.mjs";
import { claimInvitation, organizationSharing, proposeSharingMutation } from "./sharing.mjs";
import { indexProjectInvitations, pruneProjectInvitations } from "./project-invitations.mjs";
import { logAuthEvent } from "./auth-events.mjs";
import {
  bindingOf,
  checkPreviewToken,
  collaboratorsOf,
  issuePreviewToken,
  pendingInvitations,
} from "./trash.mjs";

export const SPACE_LIMIT = 50;
export const SPACE_TITLE_LIMIT = 200;
export const SPACE_DESCRIPTION_LIMIT = 2000;
const RECEIPT_LIMIT = 64;
const RECORD = "space/record";
const receiptKey = (operationKey) => `host/receipt/${operationKey.slice("host/operation/".length)}`;
/** Invitations in `after` that `before` lacks, as [id, invite] pairs. */
const addedInvites = (before, after) =>
  Object.entries(after?.acl?.invites ?? {}).filter(([id]) => !before?.acl?.invites?.[id]);

/** Sharing actions that add or remove pending invitations. */
const indexedAction = (action) => action === "invite" || action === "revoke_invite";

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
        : `${argument} expects a Page ID, but this is a Project ID. Pass it as project_id to read_page and the other Page tools to address the Project's content.`,
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

/** delete_project's arguments: a preview reads; a confirm needs the
 * preview's unchanged token. Deterministic input errors consume no key. */
export function validateSpaceDeletion(args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Invalid Project arguments");
  requireSpaceIdArgument(args.space_id);
  const allowed = ["space_id", "action", "preview_token", "nonce"];
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new HttpError(400, "Unsupported delete_project argument", "invalid_arguments");
  if (!["preview", "confirm"].includes(args.action))
    throw new HttpError(400, "action must be preview or confirm");
  if (args.action === "confirm" && typeof args.preview_token !== "string")
    throw new HttpError(
      400,
      "Call delete_project with action preview, then confirm with its unchanged preview_token",
      "purge_preview_required",
    );
  return args.action;
}

/** Body of a new Project's content document. It is ordinary Page content:
 * guidance for people and agents, never authority to widen a task. */
export function projectContentMarkdown(description) {
  const lead = description?.trim() ? description.trim() : "Describe what this Project is for.";
  return `${lead}\n\n## Guidance\n\nKeep current priorities and notes for people and agents working in this Project here.`;
}

/** Public sharing roster, never durable signing identities or ACL bookkeeping.
 * Accept receipts too so older stored replies cannot expose removed members.
 * `organizationAccess` is the organization grant without its namespace. */
export function publicProjectAccess(value) {
  const acl = value.acl ?? value;
  const organization = acl.organizationAccess;
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
    organizationAccess:
      organization && ["viewer", "commenter", "editor"].includes(organization.role)
        ? { id: organization.id, name: organization.name, role: organization.role }
        : null,
  };
}

/** The Project as its reader sees it. `role` is the relation the reader's
 * decision rests on, so a role held through the organization grant, which no
 * member row records, is reported too. */
export function publicSpace(record, identity) {
  return {
    space_id: record.space_id,
    title: record.title,
    description: record.description ?? "",
    document_id: record.document_id,
    role: identity ? projectDecision(record, identity).basis.relation ?? "none" : "owner",
    revision: record.revision ?? 0,
    owner: record.owner,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

const projectDecision = (record, identity) =>
  decide(principalOf(identity), NO_ACTOR_CHAIN, projectObject(record), Date.now());

/** Capability checks include current Project members and the organization
 * grant's current members. */
function can(capability, record, identity) {
  return projectDecision(record, identity).capabilities.includes(capability);
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
      if (path === "/internal/space/content") {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw spaceNotFound();
        const args = await readJson(request);
        requireSpaceIdArgument(args?.space_id);
        const record = await this.ctx.storage.get(RECORD);
        if (
          !record ||
          record.pending ||
          record.deletion ||
          record.space_id !== args.space_id ||
          (this.ctx.id?.name && this.ctx.id.name !== args.space_id) ||
          !validPageId(record.document_id)
        )
          throw spaceNotFound();
        await this.ctx.storage.sync();
        return json({ page_id: record.document_id, owner: record.owner });
      }
      if (path === "/internal/space/policy") {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw spaceNotFound();
        const args = await readJson(request);
        const record = await this.ctx.storage.get(RECORD);
        if (
          !record ||
          record.deletion ||
          record.space_id !== args.space_id ||
          record.owner !== args.owner
        )
          throw spaceNotFound();
        await this.ctx.storage.sync();
        return json({
          space_id: record.space_id,
          owner: record.owner,
          owner_name: record.owner_name,
          acl: record.acl,
        });
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
      if (path === "/internal/space/delete") return await this.remove(identity, args, record);
      // A Project whose deletion has started answers like a missing one on
      // every other route, and its invitations can no longer be claimed.
      if (record?.deletion) record = undefined;
      // A content-selector check (`claim: false`) only asks whether the
      // caller already reads the Project; it never claims an invitation.
      if (path === "/internal/space/read" && record && args.claim !== false) {
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
          const accepted = addedInvites(claimed, record);
          record = { ...record, acl: claimed.acl };
          await this.ctx.storage.put(RECORD, record);
          await this.ctx.storage.sync();
          for (const [inviteId] of accepted)
            await logAuthEvent({
              action: "invitation.accepted",
              principal: identity.principal,
              projectId: record.space_id,
              inviteId,
              role: record.acl.members?.[identity.principal]?.role,
            });
          // The claim is committed; a stale hint only names a Project whose
          // invite is gone, and the scheduled sweep drops it at expiry.
          await pruneProjectInvitations(this.env, record).catch(() => {});
        }
      }
      // A Space the caller cannot read looks exactly like a missing one.
      if (!record || !can("read", record, identity)) throw spaceNotFound();
      if (path === "/internal/space/read") {
        // An organization has no member list to fan out to, so a person who
        // opens the Project through its organization grant records their own
        // discovery hint. Like every hint it is a candidate: the listing
        // reads the Project again, so a person whose lease ends, or whose
        // grant clears, stops seeing it. The hint only lists the Project, so
        // a failure to write it never fails the open.
        if (
          args.claim !== false &&
          projectDecision(record, identity).basis.via === "organization"
        ) {
          try {
            const discovered = await this.env.CATALOGS.getByName(identity.principal).fetch(
              new Request("https://pages.internal/internal/project-discovery", {
                method: "POST",
                body: JSON.stringify({ space_id: record.space_id, owner: record.owner }),
              }),
            );
            await discovered.body?.cancel();
          } catch {}
        }
        return json(publicSpace(record, identity));
      }
      if (path === "/internal/space/access") {
        if (identity.principal !== record.owner)
          throw new HttpError(403, "Only the Project owner can manage access");
        if (identity.credentialKind === "oauth" && !identity.canShare)
          throw new HttpError(
            403,
            "Pages sharing permission is required",
            "oauth_insufficient_scope",
          );
        // Every answer carries the owner's organization choices for `holder`,
        // the record `value` describes. They follow the owner's leases now;
        // the roster, revision and grant are `value`'s, so a replay answers
        // as its receipt did.
        const answer = async (value, holder) => {
          const roster = publicProjectAccess(value);
          return json({
            ...roster,
            ...(await organizationSharing(holder, identity, this.env)),
            organizationAccess: roster.organizationAccess,
          });
        };
        if (!args.read) {
          requireWrite(identity);
          if (
            !["set_role", "invite", "revoke_invite", "set_organization_access"].includes(
              args.action,
            )
          )
            throw new HttpError(
              400,
              "Choose invite, set_role, revoke_invite or set_organization_access",
            );
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
                  "organization_id",
                  "role",
                  "expected_revision",
                  "nonce",
                ].includes(key),
            )
          )
            throw new HttpError(400, "Unsupported Project sharing argument");
          const key = await operationKey(args, identity, "project-access");
          const digest = await fingerprint(
            "project_access",
            {
              space_id: args.space_id,
              action: args.action,
              principal: args.principal,
              email: args.email,
              invite_id: args.invite_id,
              organization_id: args.organization_id,
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
                "This nonce was used for a different request",
                "nonce_conflict",
              );
            await this.ctx.storage.sync();
            // Repeats a hint removal that failed after the ACL committed.
            if (indexedAction(args.action)) await pruneProjectInvitations(this.env, record);
            return answer(previous.receipt, record);
          }
          const proposed = await proposeSharingMutation(
            { ...record, pageId: record.space_id },
            identity,
            args,
            Date.now(),
            this.env,
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
          if (!proposed.replay) {
            const audit = { principal: identity.principal, projectId: record.space_id };
            if (args.action === "invite")
              for (const [inviteId, invite] of addedInvites(record, next))
                await logAuthEvent({
                  action: "invitation.created",
                  ...audit,
                  inviteId,
                  role: invite.role,
                });
            if (args.action === "revoke_invite" && record.acl?.invites?.[args.invite_id])
              await logAuthEvent({
                action: "invitation.revoked",
                ...audit,
                inviteId: args.invite_id,
              });
          }
          // Hints for invites the committed ACL no longer holds (revoked or
          // replaced) go after the audit line, so a failure here leaves the
          // retry, which replays the receipt above, to finish the removal.
          if (indexedAction(args.action)) await pruneProjectInvitations(this.env, next);
          if (args.action === "set_role" && args.role === null)
            await this.env.CATALOGS.getByName(args.principal).fetch(
              new Request("https://pages.internal/internal/project-discovery", {
                method: "POST",
                body: JSON.stringify({ space_id: record.space_id, remove: true }),
              }),
            );
          return answer(receipt, next);
        }
        return answer(record, record);
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
   * crash, with the same Space ID and content document ID. */
  async create(identity, args, record) {
    requireWrite(identity);
    const { title, description } = validateSpaceInput(args, { creating: true });
    if (!validPageId(args.document_id)) throw new HttpError(400, "Invalid document_id");
    if (record) {
      if (heldRelation(projectObject(record), identity.principal) !== "owner")
        throw spaceNotFound();
      if (record.document_id !== args.document_id)
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
      document_id: args.document_id,
      revision: 0,
      created_at: now,
      updated_at: now,
    };
    await this.ctx.storage.put(RECORD, created);
    await this.ctx.storage.sync();
    return json(publicSpace(created), 201);
  }

  /**
   * One step of delete_project, which the owner's Catalog drives
   * (space-lifecycle.mjs `spaceDeletion`). `step` is:
   *
   * - preview: what deleting the Project removes, and a preview token bound
   *   to this record's revision and ACL and to the `heads` and
   *   `comment_heads` the Catalog read from the content.
   * - close: check the token against the live record and the content and
   *   comments heads the Catalog read now. A valid token records `deletion`
   *   (the intent's `deletion_id` and both heads) in the same step; from then
   *   on every other route answers like a missing Project.
   * - reopen: drop that deletion again, after the content or its comments
   *   changed.
   * - delete: remove members' discovery hints and the Project's invitation
   *   rows, then every key this object stores.
   *
   * A repeated close, reopen or delete for the same `deletion_id` answers as
   * the first did, so the Catalog can resume after a lost response.
   */
  async remove(identity, args, record) {
    requireWrite(identity);
    const step = args.step;
    if (!["preview", "close", "reopen", "delete"].includes(step))
      throw new HttpError(400, "Invalid Project deletion step");
    const ours = typeof args.deletion_id === "string" && record?.deletion?.id === args.deletion_id;
    if (step === "delete" && !record) return json({ space_id: args.space_id, deleted: true });
    if (step === "reopen" && !record?.deletion)
      return json({ space_id: args.space_id, reopened: true });
    if (!record || (record.deletion && !ours) || !can("read", record, identity))
      throw spaceNotFound();
    if (identity.principal !== record.owner)
      throw new HttpError(403, "Only the Project owner can delete it");
    const binding = ({ content_revision, heads, comment_heads }) =>
      bindingOf({
        project: record.space_id,
        principal: identity.principal,
        document_id: record.document_id,
        content_revision,
        heads: heads && [...heads].sort(),
        comment_heads: comment_heads && [...comment_heads].sort(),
        acl: record.acl ?? null,
        revision: record.revision ?? 0,
      });
    // What the Catalog read from the content's Page host: its lifecycle
    // revision, and the heads of the content and its comments document. Both
    // heads are null for a record whose documents that host doesn't open;
    // nothing can change those documents, so its revision binds the content.
    const contentHeads = () => {
      const heads = (name) =>
        Array.isArray(args[name]) && args[name].every((head) => typeof head === "string");
      const unopened = args.heads === null && args.comment_heads === null;
      if (
        !Number.isSafeInteger(args.content_revision) ||
        args.content_revision < 0 ||
        !(unopened || (heads("heads") && heads("comment_heads")))
      )
        throw new HttpError(400, "content_revision, heads and comment_heads describe the content");
      return {
        content_revision: args.content_revision,
        heads: args.heads,
        comment_heads: args.comment_heads,
      };
    };
    if (step === "preview") {
      if (record.deletion) throw spaceNotFound();
      return json({
        space_id: record.space_id,
        title: record.title,
        document_id: record.document_id,
        revision: record.revision ?? 0,
        collaborators: collaboratorsOf(record.acl),
        pending_invitations: pendingInvitations(record.acl),
        ...(await issuePreviewToken(this.ctx.storage, await binding(contentHeads()))),
      });
    }
    if (step === "close") {
      if (ours)
        return json({
          space_id: record.space_id,
          closed: true,
          heads: record.deletion.heads,
          comment_heads: record.deletion.comment_heads,
        });
      const read = contentHeads();
      const checked = await checkPreviewToken(
        this.ctx.storage,
        await binding(read),
        args.preview_token,
      );
      if (checked !== "valid")
        throw new HttpError(
          409,
          checked === "expired"
            ? "preview_token expired; preview the deletion again"
            : checked === "changed"
              ? "The Project changed after its preview; preview the deletion again"
              : "Invalid preview_token; preview the deletion again",
          "purge_preview_invalid",
        );
      await this.ctx.storage.put(RECORD, {
        ...record,
        deletion: { id: args.deletion_id, ...read, at: new Date().toISOString() },
      });
      await this.ctx.storage.sync();
      return json({ space_id: record.space_id, closed: true, ...read });
    }
    if (!ours) throw new HttpError(409, "A different deletion of this Project is in progress");
    if (step === "reopen") {
      const { deletion: _deletion, ...reopened } = record;
      await this.ctx.storage.put(RECORD, reopened);
      await this.ctx.storage.sync();
      return json({ space_id: record.space_id, reopened: true });
    }
    // Hints and invitation rows go first: once the record is gone, nothing
    // names the members whose hints a retry would still have to remove.
    for (const principal of Object.keys(record.acl?.members ?? {})) {
      const removed = await this.env.CATALOGS.getByName(principal).fetch(
        new Request("https://pages.internal/internal/project-discovery", {
          method: "POST",
          body: JSON.stringify({ space_id: record.space_id, remove: true }),
        }),
      );
      if (!removed.ok) throw new HttpError(503, "Project discovery unavailable; retry");
    }
    if (this.env.DB) await pruneProjectInvitations(this.env, { space_id: record.space_id });
    for (const key of (await this.ctx.storage.list()).keys())
      if (key !== RECORD) await this.ctx.storage.delete(key);
    await this.ctx.storage.delete(RECORD);
    await this.ctx.storage.sync();
    return json({ space_id: record.space_id, deleted: true });
  }

  async update(identity, args, record) {
    requireWrite(identity);
    if (identity.principal !== record.owner)
      throw new HttpError(403, "Only the Project owner can update it");
    const { title, description } = validateSpaceInput(args, { creating: false });
    const key = await operationKey(args, identity, "project");
    const digest = await fingerprint(
      "update_space",
      { space_id: args.space_id, title, description, expected_revision: args.expected_revision },
      identity,
    );
    const recorded = await this.ctx.storage.get(receiptKey(key));
    if (recorded) {
      if (recorded.fingerprint !== digest)
        throw new HttpError(409, "This nonce was used for a different request", "nonce_conflict");
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
