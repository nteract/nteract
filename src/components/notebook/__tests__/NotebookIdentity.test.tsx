import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  NotebookIdentityBadge,
  NotebookIdentityGroup,
  notebookActorIdentityFromAccess,
} from "../NotebookIdentity";
import type { NotebookShellCapabilities } from "../capabilities";

const cloudOwnerAccess: NotebookShellCapabilities["access"] = {
  level: "owner",
  source: "cloud",
  isPublic: false,
  actorLabel: "cloud:kyle",
  identityLabel: "Kyle",
};

describe("NotebookIdentity", () => {
  it("projects cloud access into a human identity badge", () => {
    const actor = notebookActorIdentityFromAccess(cloudOwnerAccess);

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("Owner")).toBeVisible();
  });

  it("can render inline account identity without actor presence status", () => {
    const actor = notebookActorIdentityFromAccess(cloudOwnerAccess);

    const { container } = render(
      <NotebookIdentityBadge actor={actor} variant="inline" showStatus={false} />,
    );

    expect(screen.getByText("Kyle")).toBeVisible();
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it("projects agent access as acting for an identity", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "agent:codex/on-behalf-of:kyle",
      identityLabel: "Kyle",
    });

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Codex for Kyle")).toBeVisible();
    expect(screen.getByText("Editor")).toBeVisible();
  });

  it("projects durable principal/operator labels for delegated agents", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:dev:kyle%40example.com/agent:codex:s1",
      identityLabel: null,
    });

    expect(actor.kind).toBe("agent");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Codex for kyle@example.com")).toBeVisible();
    expect(screen.getByText("Editor")).toBeVisible();
  });

  it("keeps delegated agent attribution when access scope is absent", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "none",
      source: "local",
      isPublic: false,
      actorLabel: "user:local:kyle/agent:claude:s1",
      identityLabel: "Kyle",
    });

    expect(actor.kind).toBe("agent");
    expect(actor.detail).toBeNull();

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Claude for Kyle")).toBeVisible();
    expect(screen.getByTitle("Claude for Kyle")).toBeVisible();
  });

  it("prefers structured actor projections over durable label fallback", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:anaconda:opaque/browser:tab",
      identityLabel: null,
      actor: {
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
      },
    });

    expect(actor.id).toBe("user:anaconda:opaque/browser:tab");
    expect(actor.principalLabel).toBe("Alice Appleseed");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Alice Appleseed")).toBeVisible();
    expect(screen.queryByText("Anaconda user")).toBeNull();
  });

  it("does not reparse raw labels over structured agent projections", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "agent:legacy/on-behalf-of:someone-else",
      identityLabel: null,
      actor: {
        actorLabel: "agent:legacy/on-behalf-of:someone-else",
        principal: {
          id: "user:anaconda:opaque",
          label: "Alice Appleseed",
          source: { provider: "anaconda", namespace: "anaconda" },
        },
        operator: {
          id: "agent:codex:s1",
          kind: "agent",
          label: "Codex",
        },
        scope: "editor",
      },
    });

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Codex for Alice Appleseed")).toBeVisible();
    expect(screen.getByText("Editor")).toBeVisible();
    expect(screen.queryByText("Legacy")).toBeNull();
    expect(screen.queryByText("for Someone Else")).toBeNull();
  });

  it("projects durable runtime operators separately from document access", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "viewer",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:anaconda:alice/runtime:jupyterhub",
      identityLabel: "Alice",
    });

    expect(actor.kind).toBe("runtime");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("JupyterHub for Alice")).toBeVisible();
    expect(screen.getByText("Viewer")).toBeVisible();
  });

  it("projects durable system operators separately from human identity", () => {
    const actor = notebookActorIdentityFromAccess({
      level: "viewer",
      source: "fixture",
      isPublic: false,
      actorLabel: "system/schema:notebook:v5",
      identityLabel: null,
    });

    expect(actor.kind).toBe("system");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Schema")).toBeVisible();
    expect(screen.getByText("Viewer")).toBeVisible();
  });

  it("renders grouped notebook actors with overflow", () => {
    const actors = [
      notebookActorIdentityFromAccess(cloudOwnerAccess),
      notebookActorIdentityFromAccess({
        level: "viewer",
        source: "cloud",
        isPublic: true,
        actorLabel: "public viewer",
        identityLabel: null,
      }),
      notebookActorIdentityFromAccess({
        level: "editor",
        source: "local",
        isPublic: false,
        actorLabel: "local:morgan",
        identityLabel: "Morgan",
      }),
    ];

    render(<NotebookIdentityGroup actors={actors} maxVisible={2} />);

    expect(screen.getByLabelText("Notebook actors")).toBeVisible();
    expect(screen.getByText("+1")).toBeVisible();
  });
});
