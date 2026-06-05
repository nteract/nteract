import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  friendlyNotebookActorLabel,
  notebookActorIdentityFromProjection,
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromLabel,
  notebookActorProjectionFromRuntime,
  notebookActorProjectionWithPrincipalImage,
  parseNotebookActorLabel,
  splitNotebookActorPrincipalOperator,
  type NotebookActorProjection,
  type NotebookShellAccessCapabilities,
  type NotebookShellAuthCapabilities,
  type NotebookShellRuntimeCapabilities,
} from "../src";
import { clearNotebookActorProjectionCachesForTests } from "../src/notebook-actor-projection";

function access(
  overrides: Partial<NotebookShellAccessCapabilities> = {},
): NotebookShellAccessCapabilities {
  return {
    level: "viewer",
    source: "cloud",
    isPublic: false,
    actorLabel: null,
    identityLabel: null,
    ...overrides,
  };
}

function auth(
  overrides: Partial<NotebookShellAuthCapabilities> = {},
): NotebookShellAuthCapabilities {
  return {
    canSignIn: false,
    canUseAuthenticatedIdentity: false,
    needsAttention: false,
    ...overrides,
  };
}

function runtime(
  overrides: Partial<NotebookShellRuntimeCapabilities> = {},
): NotebookShellRuntimeCapabilities {
  return {
    canWriteRuntimeState: false,
    connected: false,
    executionAvailable: false,
    source: "cloud",
    actorLabel: null,
    identityLabel: null,
    ...overrides,
  };
}

describe("notebook actor labels", () => {
  it("splits durable principal/operator labels without changing either side", () => {
    expect(
      splitNotebookActorPrincipalOperator("user:dev:kyle%40example.com/agent:codex:s1"),
    ).toEqual(["user:dev:kyle%40example.com", "agent:codex:s1"]);
  });

  it("projects delegated agents with a friendly principal label", () => {
    expect(parseNotebookActorLabel("user:dev:kyle%40example.com/agent:codex:s1")).toEqual({
      kind: "agent",
      label: "Codex",
      onBehalfOf: "kyle@example.com",
    });
  });

  it("projects runtime and system operators independently from document access", () => {
    expect(parseNotebookActorLabel("user:anaconda:alice/runtime:jupyterhub")).toEqual({
      kind: "runtime",
      label: "JupyterHub",
      onBehalfOf: "Alice",
    });
    expect(parseNotebookActorLabel("system/schema:notebook:v5")).toEqual({
      kind: "system",
      label: "Schema",
      onBehalfOf: null,
    });
  });

  it("turns raw principals into human-scale labels for presence fallbacks", () => {
    expect(friendlyNotebookActorLabel("anonymous:viewer:session-a/browser:tab")).toBe("Anonymous");
    expect(
      friendlyNotebookActorLabel("user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab"),
    ).toBe("Anaconda user");
    expect(friendlyNotebookActorLabel("user:anaconda:alice/browser:tab")).toBe("Alice");
  });
});

describe("notebook actor projection", () => {
  beforeEach(() => {
    clearNotebookActorProjectionCachesForTests();
  });

  it("returns stable frozen projections for equivalent access inputs", () => {
    const input = access({
      level: "editor",
      actorLabel: "user:dev:kyle%40example.com/agent:codex:s1",
      identityLabel: null,
    });

    const first = notebookActorProjectionFromAccess(input, auth());
    const second = notebookActorProjectionFromAccess({ ...input }, auth());

    expect(second).toBe(first);
    expect(second.principal).toBe(first.principal);
    expect(second.operator).toBe(first.operator);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.principal)).toBe(true);
    expect(Object.isFrozen(first.operator)).toBe(true);
    expect(first).toMatchObject({
      actorLabel: "user:dev:kyle%40example.com/agent:codex:s1",
      principal: {
        id: "user:dev:kyle%40example.com",
        label: "kyle@example.com",
      },
      operator: {
        kind: "agent",
        label: "Codex",
      },
      scope: "editor",
      status: "active",
    });
  });

  it("returns stable identity view objects from stable projections", () => {
    const projection = notebookActorProjectionFromLabel("user:local:kyle/runtime:python", {
      source: "local",
      scope: "runtime_peer",
      identityLabel: "Kyle",
    });

    const first = notebookActorIdentityFromProjection(projection);
    const second = notebookActorIdentityFromProjection(projection);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      id: "user:local:kyle/runtime:python",
      kind: "runtime",
      label: "Python for Kyle",
      detail: "Runtime peer",
    });
  });

  it("keeps identity image projections stable when projected from raw labels", () => {
    const first = notebookActorProjectionFromLabel("user:anaconda:alice/browser:tab", {
      source: "cloud",
      identityLabel: "Alice",
      identityImageUrl: "https://example.test/alice.png",
    });
    const second = notebookActorProjectionFromLabel("user:anaconda:alice/browser:tab", {
      source: "cloud",
      identityLabel: "Alice",
      identityImageUrl: "https://example.test/alice.png",
    });
    const otherImage = notebookActorProjectionFromLabel("user:anaconda:alice/browser:tab", {
      source: "cloud",
      identityLabel: "Alice",
      identityImageUrl: "https://example.test/alice-2.png",
    });

    expect(second).toBe(first);
    expect(first.principal.imageUrl).toBe("https://example.test/alice.png");
    expect(otherImage).not.toBe(first);
    expect(otherImage.principal.imageUrl).toBe("https://example.test/alice-2.png");
  });

  it("normalizes host-provided actor status through stable clones", () => {
    const actor: NotebookActorProjection = {
      actorLabel: "user:anaconda:opaque/browser:tab",
      principal: {
        id: "user:anaconda:opaque",
        label: "Alice Appleseed",
        source: { provider: "anaconda", namespace: "anaconda" },
      },
      operator: {
        id: "browser:tab",
        kind: "browser",
        label: "Browser",
      },
      scope: "editor",
    };
    const input = access({
      level: "editor",
      actorLabel: actor.actorLabel,
      actor,
    });

    const active = notebookActorProjectionFromAccess(input, auth());
    const repeatedActive = notebookActorProjectionFromAccess(input, auth());

    expect(active).not.toBe(actor);
    expect(repeatedActive).toBe(active);
    expect(active).toMatchObject({ status: "active" });

    const attention = notebookActorProjectionFromAccess(input, auth({ needsAttention: true }));
    const repeated = notebookActorProjectionFromAccess(input, auth({ needsAttention: true }));

    expect(attention).not.toBe(actor);
    expect(repeated).toBe(attention);
    expect(attention).toMatchObject({ status: "attention" });

    const explicitlyActive = { ...actor, status: "active" as const };
    expect(
      notebookActorProjectionFromAccess(
        access({
          level: "editor",
          actorLabel: explicitlyActive.actorLabel,
          actor: explicitlyActive,
        }),
        auth(),
      ),
    ).toBe(explicitlyActive);
  });

  it("adds principal images through a stable projection helper", () => {
    const actor = notebookActorProjectionFromAccess(
      access({
        level: "owner",
        actorLabel: "user:anaconda:alice/browser:tab",
        identityLabel: "Alice",
      }),
      auth(),
    );

    const first = notebookActorProjectionWithPrincipalImage(actor, "https://example.test/a.png");
    const second = notebookActorProjectionWithPrincipalImage(actor, "https://example.test/a.png");

    expect(second).toBe(first);
    expect(first).not.toBe(actor);
    expect(first?.principal).not.toBe(actor.principal);
    expect(first?.principal.imageUrl).toBe("https://example.test/a.png");
    expect(notebookActorProjectionWithPrincipalImage(first, "https://example.test/a.png")).toBe(
      first,
    );
  });

  it("evicts the oldest actor projections while keeping recently used entries stable", () => {
    const keptLabel = "user:local:kept/browser:tab";
    const evictedLabel = "user:local:evicted/browser:tab";
    const kept = notebookActorProjectionFromLabel(keptLabel, { source: "local" });
    const evicted = notebookActorProjectionFromLabel(evictedLabel, { source: "local" });

    for (let index = 0; index < 510; index += 1) {
      notebookActorProjectionFromLabel(`user:local:filler-${index}/browser:tab`, {
        source: "local",
      });
    }

    expect(notebookActorProjectionFromLabel(keptLabel, { source: "local" })).toBe(kept);

    notebookActorProjectionFromLabel("user:local:overflow/browser:tab", { source: "local" });

    expect(notebookActorProjectionFromLabel(keptLabel, { source: "local" })).toBe(kept);
    expect(notebookActorProjectionFromLabel(evictedLabel, { source: "local" })).not.toBe(evicted);
  });

  it("returns stable runtime actors and skips disconnected anonymous runtimes", () => {
    expect(notebookActorProjectionFromRuntime(runtime())).toBeNull();

    const first = notebookActorProjectionFromRuntime(
      runtime({
        connected: true,
        canWriteRuntimeState: true,
        actorLabel: "user:anaconda:alice/runtime:jupyterhub",
        identityLabel: "Alice",
      }),
      auth(),
    );
    const second = notebookActorProjectionFromRuntime(
      runtime({
        connected: true,
        canWriteRuntimeState: true,
        actorLabel: "user:anaconda:alice/runtime:jupyterhub",
        identityLabel: "Alice",
      }),
      auth(),
    );

    expect(second).toBe(first);
    expect(first).toMatchObject({
      operator: { kind: "runtime", label: "JupyterHub" },
      scope: "runtime_peer",
    });
  });
});
