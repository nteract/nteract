import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1Value,
  Env,
} from "../src/cloudflare-types.ts";
import {
  createPendingNotebookInvite,
  resolveNotebookInvitesForLogin,
  type PendingNotebookInviteRow,
  type PrincipalProfileRow,
} from "../src/sharing-storage.ts";
import type { NotebookAclRow } from "../src/storage.ts";
import type { AuthenticatedLoginProfile } from "../src/sharing.ts";

describe("hosted sharing storage", () => {
  it("resolves verified email invites into principal ACL rows", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: " Alice@Example.COM ",
      providerHint: " Cloudflare-Access ",
      scope: "editor",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
      expiresAt: "2026-06-24T11:00:00.000Z",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      accessLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-1"],
    );
    assert.equal(
      env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.email_normalized,
      "alice@example.com",
    );
    assert.equal(env.DB.invites.get("invite-1")?.status, "accepted");
    assert.equal(
      env.DB.invites.get("invite-1")?.accepted_by_principal,
      "user:cloudflare-access:access-sub-1",
    );
    assert.deepEqual(env.DB.acl, [
      {
        notebook_id: "notebook-1",
        subject_kind: "principal",
        subject: "user:cloudflare-access:access-sub-1",
        scope: "editor",
        created_at: "2026-05-24T12:00:00.000Z",
        updated_at: "2026-05-24T12:00:00.000Z",
        created_by_actor_label: "system/invite-resolution",
      },
    ]);
    assert.doesNotMatch(env.DB.acl[0]?.subject ?? "", /alice@example.com/);
  });

  it("does not duplicate ACL rows when invite resolution reruns", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: null,
      scope: "viewer",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    await resolveNotebookInvitesForLogin(env, accessLogin(), "2026-05-24T12:00:00.000Z");
    const second = await resolveNotebookInvitesForLogin(
      env,
      accessLogin({ displayName: "Alice Updated" }),
      "2026-05-24T12:05:00.000Z",
    );

    assert.equal(second.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 1);
    assert.equal(
      env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.display_name,
      "Alice Updated",
    );
    assert.equal(
      env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.first_seen_at,
      "2026-05-24T12:00:00.000Z",
    );
    assert.equal(
      env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.last_seen_at,
      "2026-05-24T12:05:00.000Z",
    );
  });

  it("stores a profile but skips malformed or unverified email invite lookup", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-1",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "cloudflare-access",
      scope: "editor",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
    });

    const malformed = await resolveNotebookInvitesForLogin(
      env,
      accessLogin({ email: "noatsign" }),
      "2026-05-24T12:00:00.000Z",
    );
    const unverified = await resolveNotebookInvitesForLogin(
      env,
      accessLogin({ emailVerified: false }),
      "2026-05-24T12:01:00.000Z",
    );

    assert.equal(malformed.aclGrants.length, 0);
    assert.equal(unverified.aclGrants.length, 0);
    assert.equal(env.DB.invites.get("invite-1")?.status, "pending");
    assert.equal(
      env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.email_normalized,
      null,
    );
    assert.equal(env.DB.profiles.get("user:cloudflare-access:access-sub-1")?.email_verified, 0);
  });

  it("honors provider hints while allowing explicit provider-wildcard invites", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-wildcard",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: null,
      scope: "viewer",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
    });
    await createPendingNotebookInvite(env, {
      id: "invite-github",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "github",
      scope: "editor",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      accessLogin({ provider: "cloudflare-access" }),
      "2026-05-24T12:00:00.000Z",
    );

    assert.deepEqual(
      resolution.acceptedInvites.map((invite) => invite.id),
      ["invite-wildcard"],
    );
    assert.equal(env.DB.invites.get("invite-github")?.status, "pending");
  });

  it("does not return or accept expired pending invites from storage resolution", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-expired",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "cloudflare-access",
      scope: "editor",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
      expiresAt: "2026-05-24T11:59:59.000Z",
      timestamp: "2026-05-24T11:00:00.000Z",
    });

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      accessLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
    assert.equal(env.DB.acl.length, 0);
    assert.equal(env.DB.invites.get("invite-expired")?.status, "pending");
  });

  it("reports only invites whose row actually transitioned to accepted", async () => {
    const env = fakeEnv();
    await createPendingNotebookInvite(env, {
      id: "invite-raced",
      notebookId: "notebook-1",
      email: "alice@example.com",
      providerHint: "cloudflare-access",
      scope: "editor",
      actorLabel: "user:cloudflare-access:owner/desktop:owner",
    });
    env.DB.beforeInviteAccept = (inviteId) => {
      env.DB.invites.get(inviteId)!.status = "accepted";
      env.DB.beforeInviteAccept = undefined;
    };

    const resolution = await resolveNotebookInvitesForLogin(
      env,
      accessLogin(),
      "2026-05-24T12:00:00.000Z",
    );

    assert.equal(resolution.acceptedInvites.length, 0);
    assert.equal(resolution.aclGrants.length, 0);
  });

  it("rejects invalid pending invite inputs before they become ACL material", async () => {
    const env = fakeEnv();
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "not an email",
          scope: "viewer",
          actorLabel: "user:cloudflare-access:owner/desktop:owner",
        }),
      /invite email is invalid/,
    );
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "alice@example.com",
          scope: "owner" as never,
          actorLabel: "user:cloudflare-access:owner/desktop:owner",
        }),
      /invite scope must be viewer or editor/,
    );
    await assert.rejects(
      () =>
        createPendingNotebookInvite(env, {
          notebookId: "notebook-1",
          email: "alice@example.com",
          scope: "editor",
          actorLabel: "user:cloudflare-access:owner/desktop:owner",
          expiresAt: "not a date",
        }),
      /invite expiry is invalid/,
    );
  });
});

function fakeEnv(): Env & { DB: FakeD1 } {
  return { DB: new FakeD1() } as Env & { DB: FakeD1 };
}

function accessLogin(
  overrides: Partial<AuthenticatedLoginProfile> = {},
): AuthenticatedLoginProfile {
  return {
    principal: "user:cloudflare-access:access-sub-1",
    provider: "cloudflare-access",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice Example",
    ...overrides,
  };
}

class FakeD1 implements D1Database {
  readonly profiles = new Map<string, PrincipalProfileRow>();
  readonly invites = new Map<string, PendingNotebookInviteRow>();
  readonly acl: NotebookAclRow[] = [];
  beforeInviteAccept?: (inviteId: string) => void;

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query);
  }

  async exec(): Promise<D1Result> {
    return okResult();
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class FakeD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM principal_profiles")) {
      return (this.db.profiles.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.query.includes("FROM notebook_invites")) {
      return (this.db.invites.get(this.values[0] as string) as T | undefined) ?? null;
    }
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT INTO principal_profiles")) {
      const [
        principal,
        provider,
        providerSubject,
        emailNormalized,
        emailVerified,
        displayName,
        avatarUrl,
        firstSeenAt,
        lastSeenAt,
        rawClaimsJson,
      ] = this.values as [
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        string | null,
        string,
        string,
        string | null,
      ];
      const existing = this.db.profiles.get(principal);
      this.db.profiles.set(principal, {
        principal,
        provider,
        provider_subject: providerSubject,
        email_normalized: emailNormalized,
        email_verified: emailVerified,
        display_name: displayName,
        avatar_url: avatarUrl,
        first_seen_at: existing?.first_seen_at ?? firstSeenAt,
        last_seen_at: lastSeenAt,
        raw_claims_json: rawClaimsJson,
      });
    } else if (this.query.includes("INSERT INTO notebook_invites")) {
      const [
        id,
        notebookId,
        emailNormalized,
        providerHint,
        scope,
        actorLabel,
        tokenHash,
        createdAt,
        expiresAt,
      ] = this.values as [
        string,
        string,
        string,
        string | null,
        PendingNotebookInviteRow["scope"],
        string,
        string | null,
        string,
        string | null,
      ];
      this.db.invites.set(id, {
        id,
        notebook_id: notebookId,
        email_normalized: emailNormalized,
        provider_hint: providerHint,
        scope,
        status: "pending",
        invited_by_actor_label: actorLabel,
        accepted_by_principal: null,
        token_hash: tokenHash,
        created_at: createdAt,
        expires_at: expiresAt,
        accepted_at: null,
        revoked_at: null,
        revoked_by_actor_label: null,
      });
    } else if (
      this.query.includes("INSERT INTO notebook_acl") &&
      this.query.includes("FROM notebook_invites")
    ) {
      const [subject, createdAt, updatedAt, actorLabel, inviteId, email, providerHint, now] = this
        .values as [string, string, string, string, string, string, string | null, string];
      const invite = this.db.invites.get(inviteId);
      if (invite && inviteCanResolve(invite, email, providerHint, now)) {
        this.insertAclIfMissing({
          notebook_id: invite.notebook_id,
          subject_kind: "principal",
          subject,
          scope: invite.scope,
          created_at: createdAt,
          updated_at: updatedAt,
          created_by_actor_label: actorLabel,
        });
        return okResult([], { changes: 1 });
      }
    } else if (this.query.includes("UPDATE notebook_invites")) {
      const [principal, acceptedAt, inviteId, email, providerHint, now] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      this.db.beforeInviteAccept?.(inviteId);
      const invite = this.db.invites.get(inviteId);
      if (invite && inviteCanResolve(invite, email, providerHint, now)) {
        invite.status = "accepted";
        invite.accepted_by_principal = principal;
        invite.accepted_at = acceptedAt;
        return okResult([], { changes: 1 });
      }
    }
    return okResult();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.startsWith("PRAGMA table_info")) {
      return okResult([{ name: "runtime_snapshot_key" }] as T[]);
    }
    if (this.query.includes("FROM notebook_invites")) {
      const [email, provider, now] = this.values as [string, string, string];
      return okResult(
        [...this.db.invites.values()].filter(
          (invite) =>
            invite.status === "pending" &&
            invite.email_normalized === email &&
            (invite.provider_hint === provider || invite.provider_hint === null) &&
            inviteCanResolveAt(invite, now),
        ) as T[],
      );
    }
    return okResult([]);
  }

  private insertAclIfMissing(row: NotebookAclRow): void {
    const existing = this.db.acl.find(
      (candidate) =>
        candidate.notebook_id === row.notebook_id &&
        candidate.subject_kind === row.subject_kind &&
        candidate.subject === row.subject &&
        candidate.scope === row.scope,
    );
    if (existing) {
      existing.updated_at = row.updated_at;
      return;
    }
    this.db.acl.push(row);
  }
}

function inviteCanResolve(
  invite: PendingNotebookInviteRow,
  email: string,
  providerHint: string | null,
  now: string,
): boolean {
  if (
    invite.status !== "pending" ||
    invite.email_normalized !== email ||
    (invite.provider_hint !== null && invite.provider_hint !== providerHint)
  ) {
    return false;
  }
  if (!invite.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(invite.expires_at);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

function inviteCanResolveAt(invite: PendingNotebookInviteRow, now: string): boolean {
  if (!invite.expires_at) {
    return true;
  }
  const expiresAtMs = Date.parse(invite.expires_at);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

function okResult<T = unknown>(
  results: T[] = [],
  meta: Record<string, unknown> = { changes: results.length },
): D1Result<T> {
  return { success: true, results, meta };
}
