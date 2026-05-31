import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  NotebookIdentityBadge,
  NotebookIdentityGroup,
  notebookActorFromAccess,
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
    const actor = notebookActorFromAccess(cloudOwnerAccess);

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("owner through cloud")).toBeVisible();
  });

  it("projects agent access as acting on behalf of an identity", () => {
    const actor = notebookActorFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "agent:codex/on-behalf-of:kyle",
      identityLabel: "Kyle",
    });

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("on behalf of Kyle")).toBeVisible();
  });

  it("projects durable principal/operator labels for delegated agents", () => {
    const actor = notebookActorFromAccess({
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:dev:kyle%40example.com/agent:codex:s1",
      identityLabel: null,
    });

    expect(actor.kind).toBe("agent");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("on behalf of kyle@example.com")).toBeVisible();
  });

  it("projects durable runtime operators separately from document access", () => {
    const actor = notebookActorFromAccess({
      level: "viewer",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:anaconda:alice/runtime:jupyterhub",
      identityLabel: "Alice",
    });

    expect(actor.kind).toBe("runtime");

    render(<NotebookIdentityBadge actor={actor} />);

    expect(screen.getByText("JupyterHub")).toBeVisible();
    expect(screen.getByText("for Alice")).toBeVisible();
  });

  it("projects durable system operators separately from human identity", () => {
    const actor = notebookActorFromAccess({
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
      notebookActorFromAccess(cloudOwnerAccess),
      notebookActorFromAccess({
        level: "viewer",
        source: "cloud",
        isPublic: true,
        actorLabel: "public viewer",
        identityLabel: null,
      }),
      notebookActorFromAccess({
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
