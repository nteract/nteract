/**
 * The authorization seam.
 *
 *   decide(principal, actorChain, object, now)
 *     -> { capabilities, valid_until, revision, authority_token, basis }
 *
 * decide() is pure and synchronous. It reads only the relation snapshot the
 * item host already holds: the item's own ACL, a copy of its project's ACL,
 * and the item's lifecycle. Policy hooks call it per frame, so it never
 * awaits, fetches or reads a clock. In this build the project copy is
 * synthesized from the Page owner and carries no lease.
 *
 * Three steps, in this order:
 *
 *  1. Relations. The paths through `object.relations` and `object.container`
 *     that reach the principal, per authz/schema.zed.
 *  2. Lifecycle overlay. nteract owns lifecycle. A trashed item keeps only
 *     read, restore and purge, and only for principals who may restore it; a
 *     deleted or missing item grants nothing. No relation can reopen a
 *     trashed item, because this runs after every relation.
 *  3. Credential ceiling. A credential without write keeps only read.
 *
 * `revision` is nteract's own increasing ACL revision, the fence that writes
 * compare. `authority_token` is an opaque consistency token from a host's
 * relationship service (a SpiceDB ZedToken, for example). The built-in
 * implementation has none and returns null; nothing stores or round-trips it
 * yet, and nothing may compare it for ordering.
 *
 * `basis` explains the decision for nteract's own labels: the strongest
 * relation that survived the lifecycle overlay (owner, editor, viewer) and the
 * path that supplied it (direct, project, organization, group). It names the
 * role a credential holds even when the ceiling removed every write.
 */

/** Every capability decide() can return. Execute is out of scope for Pages. */
export const CAPABILITIES = Object.freeze([
  "read",
  "comment",
  "edit",
  "share",
  "administer",
  "trash",
  "restore",
  "purge",
  "create_items",
  "manage_members",
  "move_within",
  "move_out",
]);

const PAGE_CAPABILITIES = [
  "read",
  "comment",
  "edit",
  "share",
  "administer",
  "trash",
  "restore",
  "purge",
  "create_items",
  "move_within",
  "move_out",
];
const PROJECT_CAPABILITIES = [
  "read",
  "edit",
  "share",
  "administer",
  "trash",
  "restore",
  "purge",
  "create_items",
  "manage_members",
  "move_within",
  "move_out",
];

/** Capabilities per object type; each is a permission of that definition in schema.zed. */
export const OBJECT_CAPABILITIES = Object.freeze({
  page: Object.freeze(PAGE_CAPABILITIES),
  project: Object.freeze(PROJECT_CAPABILITIES),
});

/** What each relation grants on its own object. Mirrors schema.zed. */
const GRANTS = {
  page: {
    owner: PAGE_CAPABILITIES,
    editor: ["read", "comment", "edit"],
    viewer: ["read"],
  },
  project: {
    owner: PROJECT_CAPABILITIES,
    editor: ["read", "trash", "restore", "create_items", "move_within"],
    viewer: ["read"],
  },
};

/** What a project relation grants on an item the project holds: the
 * `project->` arrows in schema.zed's page definition. */
const INHERITED = {
  owner: PAGE_CAPABILITIES,
  editor: ["read", "comment", "edit", "trash", "restore", "create_items", "move_within"],
  viewer: ["read"],
};

/** A trashed item keeps these, for principals who may restore it. */
const TRASHED_KEEP = new Set(["read", "administer", "restore", "purge"]);
const RANK = { owner: 3, editor: 2, viewer: 1 };
const VIA_PREFERENCE = { direct: 0, project: 1, group: 2, organization: 3 };
const NO_BASIS = Object.freeze({ relation: null, via: null });

const subjects = (value) => (Array.isArray(value) ? value : []);
const user = (id) => ({ type: "user", id });

/** A leased membership counts only while its lease is current. Built-in
 * company view memberships always carry the email-domain lease's expiry. */
function membershipUntil(principal, subject, now) {
  for (const membership of subjects(principal.memberships)) {
    if (
      membership?.type === subject.type &&
      membership.id === subject.id &&
      Number.isFinite(membership.expires_at) &&
      membership.expires_at > now
    )
      return membership.expires_at;
  }
  return null;
}

/** Paths from one relation's subjects to the principal: [{ via, until }]. */
function reach(principal, relation, now, { exclude = false } = {}) {
  if (exclude) return [];
  const found = [];
  for (const subject of subjects(relation)) {
    if (subject?.type === "user") {
      if (subject.id === principal.id) found.push({ via: "direct", until: Infinity });
    } else if (subject?.type === "organization" || subject?.type === "group") {
      const until = membershipUntil(principal, subject, now);
      if (until !== null) found.push({ via: subject.type, until });
    }
  }
  return found;
}

/** The leased copy of the item's project, when it matches and is current. */
function containerFor(object, now) {
  const project = subjects(object.relations?.project)[0];
  const container = object.container;
  if (!project || container?.type !== "project" || container.id !== project.id) return null;
  if (container.valid_until !== undefined && !(container.valid_until > now)) return null;
  return container;
}

/** Step 1: every relation path that reaches the principal. */
function relationPaths(principal, object, now) {
  const relations = object.relations ?? {};
  const paths = [];
  const add = (relation, grants, found) => {
    for (const path of found) paths.push({ relation, grants, ...path });
  };
  if (object.type === "project") {
    for (const relation of ["owner", "editor", "viewer"])
      add(relation, GRANTS.project[relation], reach(principal, relations[relation], now));
    return paths;
  }
  // An item has a project or an owner, never both. Fail closed on both.
  const owned = subjects(relations.owner).length > 0;
  const placed = subjects(relations.project).length > 0;
  if (owned && placed) return paths;
  const removed = subjects(relations.removed).some(
    (subject) => subject?.type === "user" && subject.id === principal.id,
  );
  add("owner", GRANTS.page.owner, reach(principal, relations.owner, now));
  add("editor", GRANTS.page.editor, reach(principal, relations.editor, now));
  add("viewer", GRANTS.page.viewer, reach(principal, relations.viewer, now, { exclude: removed }));
  const container = placed ? containerFor(object, now) : null;
  if (container) {
    const until = container.valid_until ?? Infinity;
    for (const relation of ["owner", "editor", "viewer"])
      for (const path of reach(principal, container.relations?.[relation], now))
        paths.push({
          relation,
          grants: INHERITED[relation],
          via: "project",
          until: Math.min(until, path.until),
        });
  }
  return paths;
}

/** Steps 2 and 3 over a set of paths. Returns capabilities and the basis. */
function evaluate(paths, object, principal) {
  let capabilities = new Set(paths.flatMap((path) => path.grants));
  let basisPaths = paths;
  if (object.lifecycle === "trashed") {
    if (!capabilities.has("restore")) capabilities = new Set();
    else capabilities = new Set([...capabilities].filter((name) => TRASHED_KEEP.has(name)));
    basisPaths = capabilities.size ? paths.filter((path) => path.grants.includes("restore")) : [];
  } else if (object.lifecycle !== "active") {
    capabilities = new Set();
    basisPaths = [];
  }
  const basis = basisPaths.reduce(
    (best, path) =>
      !best.relation ||
      RANK[path.relation] > RANK[best.relation] ||
      (RANK[path.relation] === RANK[best.relation] &&
        VIA_PREFERENCE[path.via] < VIA_PREFERENCE[best.via])
        ? { relation: path.relation, via: path.via }
        : best,
    NO_BASIS,
  );
  if (principal.can_write !== true)
    capabilities = new Set([...capabilities].filter((name) => name === "read"));
  const order = OBJECT_CAPABILITIES[object.type];
  return { capabilities: order.filter((name) => capabilities.has(name)), basis };
}

const sameSet = (a, b) => a.length === b.length && a.every((name, index) => name === b[index]);

/** The built-in decision. See the module comment for the contract. `actorChain`
 * is carried for attribution; built-in decisions never depend on it, and a
 * verified chain may only narrow a person's capabilities. */
export function decide(principal, actorChain, object, now) {
  const revision = Number.isSafeInteger(object?.revision) ? object.revision : 0;
  const denied = {
    capabilities: [],
    valid_until: null,
    revision,
    authority_token: null,
    basis: NO_BASIS,
  };
  if (!object || !OBJECT_CAPABILITIES[object.type]) return denied;
  if (
    typeof principal?.id !== "string" ||
    !Number.isFinite(principal.expires_at) ||
    !(principal.expires_at > now)
  )
    return denied;
  const paths = relationPaths(principal, object, now);
  const { capabilities, basis } = evaluate(paths, object, principal);
  if (!capabilities.length) return { ...denied, basis };
  // The decision holds until the credential expires or the first lease whose
  // loss would change the capabilities, whichever comes first.
  let validUntil = principal.expires_at;
  for (const until of [...new Set(paths.map((path) => path.until))].sort((a, b) => a - b)) {
    if (!(until < validUntil)) break;
    const remaining = evaluate(
      paths.filter((path) => path.until > until),
      object,
      principal,
    ).capabilities;
    if (!sameSet(remaining, capabilities)) {
      validUntil = until;
      break;
    }
  }
  return {
    capabilities,
    valid_until: validUntil,
    revision,
    authority_token: null,
    basis,
  };
}

/**
 * The strongest relation a principal holds on an object through direct or
 * project grants, ignoring lifecycle, credentials and leased memberships.
 * Disclosure of a trashed or deleted item asks this question: the lifecycle
 * overlay removes every capability, but the owner and current grant holders
 * may still learn what happened to it.
 */
export function heldRelation(object, principal) {
  if (typeof principal !== "string" || !object) return "none";
  const paths = relationPaths(
    { id: principal, expires_at: Infinity, memberships: [] },
    { ...object, lifecycle: "active" },
    -Infinity,
  );
  return paths.reduce(
    (best, path) => (RANK[path.relation] > (RANK[best] ?? 0) ? path.relation : best),
    "none",
  );
}

// ---------------------------------------------------------------------------
// Adapters from today's host records. They build decide()'s input; they never
// decide anything themselves.

/** Host lifecycle state of a Page record.
 *
 * A trashed record keeps `deleted: true` so builds that predate Trash treat it
 * as unavailable to every caller. It is distinguished from a permanent
 * deletion by its `trash` entry and the absence of `purged`. Records deleted
 * before Trash existed have neither field and remain permanently deleted.
 */
export function pageState(metadata) {
  if (!metadata) return "missing";
  if (!metadata.deleted) return "active";
  return metadata.trash && !metadata.purged ? "trashed" : "deleted";
}

const roles = new Set(["viewer", "editor", "none"]);

function readRow(member) {
  if (
    !member ||
    !roles.has(member.role) ||
    !Number.isSafeInteger(member.generation) ||
    member.generation < 1
  )
    return null;
  return { role: member.role, generation: member.generation };
}

/** A stored member row, or null when the row is absent or unreadable. Role
 * "none" is a removal tombstone: it keeps the generation so a regrant cannot
 * revive an earlier signing key. One lookup, whatever the ACL's size. */
export function memberRow(members, principal) {
  return members && Object.hasOwn(members, principal) ? readRow(members[principal]) : null;
}

/** Company view as an organization subject. Built-in mode has no tenants: a
 * Page's company audience and a credential's verified email-domain lease
 * name the same organization when namespace and domain both match. Both sides
 * are host-written strings. */
const companyOrganization = (namespace, domain) =>
  typeof namespace === "string" && typeof domain === "string"
    ? JSON.stringify([namespace, domain])
    : null;

/**
 * decide()'s object for a Page record, scoped to one principal.
 *
 * The relations hold the owner (or the project), company view, and only the
 * principal's own member row, so building one costs a single member lookup
 * however many grants and tombstones the ACL has collected. A viewer or editor
 * row grants. Any other row (a removal tombstone or an unreadable row) becomes
 * `removed`, which blocks company view. A Page placed in a Space has the
 * `project` relation instead of `owner`. Spaces are owner-only in this build
 * and only a Space's owner places Pages in it, so the project copy is
 * synthesized from the Page record's owner.
 */
export function pageObject(metadata, principal) {
  const lifecycle = pageState(metadata);
  const editor = [];
  const viewer = [];
  const removed = [];
  const members = metadata?.acl?.members;
  if (typeof principal === "string" && members && Object.hasOwn(members, principal)) {
    const row = readRow(members[principal]);
    if (row?.role === "editor") editor.push(user(principal));
    else if (row?.role === "viewer") viewer.push(user(principal));
    else removed.push(user(principal));
  }
  const domainView = metadata?.acl?.domainView;
  const company = domainView && companyOrganization(domainView.namespace, domainView.domain);
  if (company) viewer.push({ type: "organization", id: company });
  const spaceId = metadata?.placement?.space_id;
  const placed = typeof spaceId === "string" && spaceId.length > 0;
  return {
    type: "page",
    id: metadata?.pageId ?? null,
    revision: metadata?.acl?.revision ?? 0,
    lifecycle,
    relations: {
      owner: placed ? [] : [user(metadata?.owner)],
      project: placed ? [{ type: "project", id: spaceId }] : [],
      editor,
      viewer,
      removed,
    },
    container: placed
      ? {
          type: "project",
          id: spaceId,
          revision: 0,
          relations: { owner: [user(metadata.owner)], editor: [], viewer: [] },
        }
      : null,
  };
}

/** decide()'s object for a Space record. Owner-only in this build: the
 * record's member list stays empty and grants nothing. */
export function projectObject(record) {
  return {
    type: "project",
    id: record?.space_id ?? null,
    revision: record?.acl?.revision ?? 0,
    lifecycle: record ? "active" : "missing",
    relations: { owner: record ? [user(record.owner)] : [], editor: [], viewer: [] },
    container: null,
  };
}

/**
 * decide()'s principal for an authenticated identity. The credential's write
 * scope is its ceiling. A verified company email-domain lease is the only
 * membership built-in mode knows; it counts only when it was issued for the
 * identity's own namespace.
 */
export function principalOf(identity) {
  const evidence = identity?.domainAccess;
  const company =
    evidence &&
    identity.namespace === evidence.namespace &&
    Number.isFinite(evidence.expiresAt) &&
    companyOrganization(evidence.namespace, evidence.domain);
  return {
    id: identity?.principal,
    expires_at: identity?.expiresAt,
    can_write: !!identity?.canWrite,
    memberships: company
      ? [{ type: "organization", id: company, expires_at: evidence.expiresAt }]
      : [],
  };
}

/** No verified delegation exists in this build. Driver labels (`x-operator`,
 * `x-pages-driver`) are attribution only and never enter the chain. */
export const NO_ACTOR_CHAIN = Object.freeze([]);
