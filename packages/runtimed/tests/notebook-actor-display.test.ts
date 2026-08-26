import { describe, expect, it } from "vite-plus/test";
import { colorForActorIdentity } from "../src/notebook-actor-color";
import { actorInitials, resolveActorDisplay } from "../src/notebook-actor-display";
import { notebookAgentBrandSlug } from "../src/notebook-actor-projection";

const ANACONDA_PRINCIPAL = "user:anaconda:550e8400-e29b-41d4-a716-446655440000";
const ANACONDA_ACTOR = `${ANACONDA_PRINCIPAL}/browser:tab-a`;

describe("resolveActorDisplay", () => {
  it("uses the matching presence peer label for an anaconda principal", () => {
    expect(
      resolveActorDisplay({
        actorLabel: ANACONDA_ACTOR,
        peers: [
          {
            participantKey: ANACONDA_PRINCIPAL,
            label: "Kyle Kelley",
            imageUrl: "https://profiles.example/kyle.png",
          },
        ],
        source: "cloud",
      }),
    ).toMatchObject({
      displayName: "Kyle Kelley",
      principalId: ANACONDA_PRINCIPAL,
      kind: "human",
      isAgent: false,
      onBehalfOf: null,
      color: colorForActorIdentity(ANACONDA_ACTOR),
      initials: "KK",
      imageUrl: "https://profiles.example/kyle.png",
    });
  });

  it("falls back to the friendly anaconda principal label without a peer", () => {
    expect(
      resolveActorDisplay({
        actorLabel: ANACONDA_ACTOR,
        peers: [],
        source: "cloud",
      }).displayName,
    ).toBe("Anaconda user");
  });

  it("projects agent authors with an on-behalf-of principal", () => {
    expect(
      resolveActorDisplay({
        actorLabel: "user:dev:kyle%40example.com/agent:codex:s1",
        peers: [{ participantKey: "user:dev:kyle%40example.com", label: "Kyle Kelley" }],
        source: "cloud",
      }),
    ).toMatchObject({
      displayName: "Codex",
      principalId: "user:dev:kyle%40example.com",
      kind: "agent",
      isAgent: true,
      agentSlug: "codex",
      onBehalfOf: "Kyle Kelley",
      initials: "CO",
    });
  });

  it("keeps a modern agent's authenticated principal separate from its brand slug", () => {
    const actorLabel = "user:oidc:authenticated-subject/agent:claude-code:s1";

    expect(
      resolveActorDisplay({
        actorLabel,
        peers: [
          {
            participantKey: "user:oidc:authenticated-subject",
            label: "Ada Lovelace",
          },
        ],
        source: "cloud",
      }),
    ).toMatchObject({
      displayName: "Claude Code",
      principalId: "user:oidc:authenticated-subject",
      kind: "agent",
      isAgent: true,
      agentSlug: "claude-code",
      onBehalfOf: "Ada Lovelace",
    });
    expect(notebookAgentBrandSlug(actorLabel)).toBe("claude-code");
  });

  it("preserves legacy agent labels while extracting their product slug", () => {
    const actorLabel = "agent:codex/on-behalf-of:Ada Lovelace";

    expect(
      resolveActorDisplay({
        actorLabel,
        peers: [],
        source: "local",
      }),
    ).toMatchObject({
      displayName: "Codex",
      kind: "agent",
      isAgent: true,
      agentSlug: "codex",
      onBehalfOf: "Ada Lovelace",
    });
    expect(notebookAgentBrandSlug(actorLabel)).toBe("codex");
  });

  it("uses a friendly display name for a local human principal", () => {
    expect(
      resolveActorDisplay({
        actorLabel: "user:local:ada/desktop:app",
        peers: [],
        source: "local",
      }).displayName,
    ).toBe("Ada");
  });

  it("uses the local presence peer label for the local principal", () => {
    // The desktop host feeds the OS full name through a peers entry keyed by the
    // local principal, so only the local author is relabeled; other principals
    // keep their own friendly labels.
    const localActor = "user:local:kylekelley/desktop:app";
    const [localPrincipal] = localActor.split("/");
    expect(
      resolveActorDisplay({
        actorLabel: localActor,
        peers: [{ participantKey: localPrincipal, label: "Kyle Kelley" }],
        source: "local",
      }).displayName,
    ).toBe("Kyle Kelley");
  });

  it("derives initials across names, delimiters, and email-like labels", () => {
    expect(actorInitials("Kyle Kelley")).toBe("KK");
    expect(actorInitials("kyle.kelley")).toBe("KK");
    expect(actorInitials("Alice")).toBe("AL");
    expect(actorInitials("a")).toBe("A");
    expect(actorInitials("rgbkrk@gmail.com")).toBe("U");
    expect(actorInitials("")).toBe("U");
  });
});
