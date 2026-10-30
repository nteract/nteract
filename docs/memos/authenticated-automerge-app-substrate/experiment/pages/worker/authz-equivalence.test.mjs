import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAccess, pageDecision, pageGrant, pageRelation } from "./access.mjs";
import {
  legacyDisclosesDeletion,
  legacyLeaseExpiresAt,
  legacyPageAccess,
  legacyPageGrant,
  legacySpaceOwner,
} from "./access-legacy-fixture.mjs";
import { NO_ACTOR_CHAIN, decide, heldRelation, principalOf, projectObject } from "./authz.mjs";

// decide() must reproduce the access rules it replaced, exactly, on every
// combination of record and credential the old rules distinguished.

const now = 1_000_000;
const principal = "ns:person";
const owner = "ns:owner";
const company = { domain: "anaconda.com", namespace: "ns" };

const lifecycles = {
  missing: null,
  active: {},
  trashed: { deleted: true, trash: { trashedAt: "2026-10-01T00:00:00Z" } },
  deletedBeforeTrash: { deleted: true },
  purged: { deleted: true, trash: { trashedAt: "2026-10-01T00:00:00Z" }, purged: true },
};
const placements = {
  personal: undefined,
  space: {
    space_id: "sp_8f62cd68-a040-4ac0-ad23-c0afb5c0a2f2",
    parent_id: null,
    position: "a0",
    placement_epoch: 0,
  },
};
const domainViews = {
  absent: undefined,
  restricted: null,
  company,
  otherDomain: { domain: "example.com", namespace: "ns" },
  otherNamespace: { domain: "anaconda.com", namespace: "other" },
};
// The principal's own row on the Page. "owner" makes them the record's owner.
const rows = {
  owner: "owner",
  editor: { role: "editor", generation: 2 },
  viewer: { role: "viewer", generation: 1 },
  tombstone: { role: "none", generation: 3 },
  generationZero: { role: "viewer", generation: 0 },
  unknownRole: { role: "admin", generation: 1 },
  nullRow: null,
  stringRow: "viewer",
  stranger: undefined,
};
const expiries = {
  valid: now + 10_000,
  expired: now - 1,
  boundary: now,
  missing: undefined,
  notANumber: Number.NaN,
};
const namespaces = { ns: "ns", other: "other" };
const evidence = {
  none: undefined,
  current: { ...company, expiresAt: now + 500 },
  outlivesCredential: { ...company, expiresAt: now + 50_000 },
  expired: { ...company, expiresAt: now - 1 },
  unbounded: { ...company, expiresAt: Infinity },
  otherDomain: { domain: "example.com", namespace: "ns", expiresAt: now + 500 },
  otherNamespace: { domain: "anaconda.com", namespace: "other", expiresAt: now + 500 },
};

function record(lifecycle, placement, domainView, row) {
  if (lifecycles[lifecycle] === null) return undefined;
  const members = {
    // Bystanders: another grant and another tombstone on the same Page.
    "ns:bystander": { role: "editor", generation: 1 },
    "ns:removed": { role: "none", generation: 2 },
  };
  if (rows[row] !== undefined && rows[row] !== "owner") members[principal] = rows[row];
  return {
    pageId: "4d6c2c0e-5a43-4a3e-9e43-0d2f6f8c9b11",
    owner: rows[row] === "owner" ? principal : owner,
    acl: {
      revision: 4,
      members,
      ...(domainViews[domainView] !== undefined && { domainView: domainViews[domainView] }),
    },
    ...lifecycles[lifecycle],
    ...(placements[placement] && { placement: placements[placement] }),
  };
}

function* matrix() {
  for (const lifecycle of Object.keys(lifecycles))
    for (const placement of Object.keys(placements))
      for (const domainView of Object.keys(domainViews))
        for (const row of Object.keys(rows))
          for (const expiry of Object.keys(expiries))
            for (const canWrite of [true, false])
              for (const namespace of Object.keys(namespaces))
                for (const proof of Object.keys(evidence))
                  yield {
                    label: {
                      lifecycle,
                      placement,
                      domainView,
                      row,
                      expiry,
                      canWrite,
                      namespace,
                      proof,
                    },
                    metadata: record(lifecycle, placement, domainView, row),
                    identity: {
                      principal,
                      canWrite,
                      expiresAt: expiries[expiry],
                      namespace: namespaces[namespace],
                      ...(evidence[proof] && { domainAccess: evidence[proof] }),
                    },
                  };
}

test("decide() reproduces pageAccess, pageGrant, the lease bound and disclosure on every combination", (t) => {
  let cases = 0;
  let readable = 0;
  for (const { label, metadata, identity } of matrix()) {
    cases++;
    const options = { now };
    const message = JSON.stringify(label);
    const expected = legacyPageAccess(metadata, identity, options);
    assert.deepStrictEqual(pageAccess(metadata, identity, options), expected, message);
    assert.deepStrictEqual(
      pageGrant(metadata, identity.principal),
      legacyPageGrant(metadata, identity.principal),
      message,
    );
    if (expected.canRead) {
      readable++;
      assert.equal(
        pageDecision(metadata, identity, options).valid_until,
        legacyLeaseExpiresAt(metadata, identity, options),
        message,
      );
    }
    if (metadata) {
      const relation = pageRelation(metadata, identity.principal);
      assert.equal(relation !== "none", legacyDisclosesDeletion(metadata, principal), message);
      assert.equal(relation === "owner", metadata.owner === principal, message);
    }
  }
  // 5 lifecycles × 2 placements × 5 domain settings × 9 rows × 5 expiries ×
  // 2 write scopes × 2 namespaces × 7 proofs.
  assert.equal(cases, 63_000);
  t.diagnostic(`equivalence matrix: ${cases} combinations, ${readable} readable`);
});

test("decide() reproduces the owner-only Space checks for authenticated callers", () => {
  const space = {
    space_id: "sp_8f62cd68-a040-4ac0-ad23-c0afb5c0a2f2",
    owner,
    acl: { revision: 0, members: {} },
  };
  for (const caller of [owner, principal, "other:owner"])
    for (const canWrite of [true, false]) {
      const identity = { principal: caller, canWrite, expiresAt: now + 1 };
      const capabilities = decide(
        principalOf(identity),
        NO_ACTOR_CHAIN,
        projectObject(space),
        now,
      ).capabilities;
      assert.equal(capabilities.includes("read"), legacySpaceOwner(space, caller));
      assert.equal(
        heldRelation(projectObject(space), caller) === "owner",
        legacySpaceOwner(space, caller),
      );
    }
});

// The two places the seam is stricter than the rules it replaced. Both fail
// closed rather than grant. No producer of an identity without a principal is
// known: authenticate() always sets one. An expired credential does reach the
// Space check: authenticate() returns an unexpired credential, but the Space
// reads the request body and its record before it checks, against a fresh
// clock (spaces.test.mjs pins that route).
test("decide() refuses an identity without a principal, which company view used to admit", () => {
  const metadata = record("active", "personal", "company", "stranger");
  const identity = {
    canWrite: false,
    expiresAt: now + 10,
    namespace: "ns",
    domainAccess: evidence.current,
  };
  assert.equal(legacyPageAccess(metadata, identity, { now }).canRead, true);
  assert.equal(pageAccess(metadata, identity, { now }).canRead, false);
});

test("Space checks now also require an unexpired credential, as Page checks always have", () => {
  const space = {
    space_id: "sp_8f62cd68-a040-4ac0-ad23-c0afb5c0a2f2",
    owner,
    acl: { revision: 0, members: {} },
  };
  const identity = { principal: owner, canWrite: true, expiresAt: now };
  assert.equal(legacySpaceOwner(space, owner), true);
  assert.deepEqual(
    decide(principalOf(identity), NO_ACTOR_CHAIN, projectObject(space), now).capabilities,
    [],
  );
});

/** Counts every inspection of a members object: lookups, presence checks and
 * enumeration. */
function countedMembers(members) {
  const counts = { inspections: 0, enumerations: 0 };
  const proxy = new Proxy(members, {
    get(target, key, receiver) {
      counts.inspections++;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      counts.inspections++;
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      counts.inspections++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      counts.enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  return { proxy, counts };
}

test("a decision inspects only the caller's member row, however many tombstones the ACL holds", (t) => {
  const measure = (tombstones, row) => {
    const members = Object.fromEntries(
      Array.from({ length: tombstones }, (_, index) => [
        `ns:removed-${index}`,
        { role: "none", generation: 2 },
      ]),
    );
    if (row) members[principal] = row;
    const { proxy, counts } = countedMembers(members);
    const metadata = {
      pageId: "4d6c2c0e-5a43-4a3e-9e43-0d2f6f8c9b11",
      owner,
      acl: { revision: 1001, members: proxy, domainView: company },
    };
    const identity = {
      principal,
      canWrite: true,
      expiresAt: now + 10_000,
      namespace: "ns",
      domainAccess: evidence.current,
    };
    const decision = pageDecision(metadata, identity, { now });
    const afterDecide = { ...counts };
    pageAccess(metadata, identity, { now });
    const afterAccess = { ...counts };
    pageRelation(metadata, principal);
    return { decision, decide: afterDecide, access: afterAccess, relation: { ...counts } };
  };
  for (const row of [
    undefined,
    { role: "viewer", generation: 1 },
    { role: "none", generation: 3 },
  ]) {
    const small = measure(10, row);
    const large = measure(1000, row);
    assert.deepEqual(large.decision, small.decision);
    for (const step of ["decide", "access", "relation"]) {
      assert.deepEqual(large[step], small[step], `${step} with row ${JSON.stringify(row)}`);
      assert.equal(large[step].enumerations, 0);
    }
    // One presence check and, when the row exists, one read.
    assert.ok(large.decide.inspections <= 2, JSON.stringify(large.decide));
    t.diagnostic(
      `1000 tombstones, row ${JSON.stringify(row ?? null)}: decide ${large.decide.inspections}, ` +
        `decide+pageAccess ${large.access.inspections}, +pageRelation ${large.relation.inspections} inspections, 0 enumerations`,
    );
  }
});
