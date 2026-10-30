import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAccess, pageDecision, pageGrant } from "./access.mjs";
import { heldRelation, pageObject } from "./authz.mjs";
import {
  legacyDisclosesDeletion,
  legacyLeaseExpiresAt,
  legacyPageAccess,
  legacyPageGrant,
  legacySpaceOwner,
} from "./access-legacy-fixture.mjs";
import { NO_ACTOR_CHAIN, decide, principalOf, projectObject } from "./authz.mjs";

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
      const relation = heldRelation(pageObject(metadata), identity.principal);
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

// The two places the seam is stricter than the rules it replaced. Neither is
// reachable through authenticate(), which always returns a principal and an
// unexpired credential; both fail closed rather than grant.
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
