import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { readOnlyNotebookShellCapabilities } from "../capabilities";
import { NotebookToolbarIdentity, notebookToolbarActors } from "../NotebookToolbarIdentity";
import type { NotebookShellCapabilities } from "../capabilities";

function capabilities(
  overrides: Partial<NotebookShellCapabilities> = {},
): NotebookShellCapabilities {
  return {
    ...readOnlyNotebookShellCapabilities,
    ...overrides,
    access: {
      ...readOnlyNotebookShellCapabilities.access,
      ...overrides.access,
    },
    auth: {
      ...readOnlyNotebookShellCapabilities.auth,
      ...overrides.auth,
    },
    runtime: {
      ...readOnlyNotebookShellCapabilities.runtime,
      ...overrides.runtime,
    },
  };
}

describe("NotebookToolbarIdentity", () => {
  it("dedupes the same actor when document access and runtime authorship match", () => {
    const actor = {
      actorLabel: "user:anaconda:alice/runtime:jupyterhub",
      principal: {
        id: "user:anaconda:alice",
        label: "Alice",
        source: { provider: "anaconda", namespace: "anaconda" },
      },
      operator: {
        id: "runtime:jupyterhub",
        kind: "runtime",
        label: "JupyterHub",
      },
      scope: "runtime_peer",
    } satisfies NonNullable<NotebookShellCapabilities["access"]["actor"]>;
    const actors = notebookToolbarActors(
      capabilities({
        access: {
          level: "editor",
          source: "cloud",
          isPublic: false,
          actorLabel: actor.actorLabel,
          identityLabel: "Alice",
          actor,
        },
        runtime: {
          connected: true,
          canWriteRuntimeState: true,
          source: "cloud",
          actorLabel: actor.actorLabel,
          identityLabel: "Alice",
          actor,
        },
      }),
    );

    expect(actors).toHaveLength(1);
    expect(actors[0]?.label).toBe("JupyterHub for Alice");
    expect(actors[0]?.detail).toBe("Runtime peer");
  });

  it("keeps desktop access, agent, and runtime actors distinct", () => {
    const actors = notebookToolbarActors(
      capabilities({
        access: {
          level: "editor",
          source: "local",
          isPublic: false,
          actorLabel: "user:local:kyle/agent:codex:s1",
          identityLabel: "Kyle",
        },
        runtime: {
          connected: true,
          canWriteRuntimeState: true,
          source: "local",
          actorLabel: "user:local:kyle/runtime:python",
          identityLabel: "Kyle",
        },
      }),
    );

    expect(actors.map((actor) => actor.kind)).toEqual(["agent", "runtime"]);
    expect(actors.map((actor) => actor.label)).toEqual(["Codex for Kyle", "Python for Kyle"]);
    expect(actors.map((actor) => actor.detail)).toEqual(["Editor", "Runtime peer"]);
  });

  it("renders the shared toolbar actor badges", () => {
    render(
      <NotebookToolbarIdentity
        capabilities={capabilities({
          access: {
            level: "owner",
            source: "cloud",
            isPublic: false,
            actorLabel: "user:anaconda:kyle/browser:tab",
            identityLabel: "Kyle",
          },
          runtime: {
            connected: true,
            canWriteRuntimeState: true,
            source: "cloud",
            actorLabel: "user:anaconda:kyle/runtime:jupyterhub",
            identityLabel: "Kyle",
          },
        })}
      />,
    );

    expect(screen.getByLabelText("Notebook actors")).toBeVisible();
    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("JupyterHub for Kyle")).toBeVisible();
  });

  it("can render actors as inline app chrome", () => {
    render(
      <NotebookToolbarIdentity
        variant="inline"
        capabilities={capabilities({
          access: {
            level: "owner",
            source: "cloud",
            isPublic: false,
            actorLabel: "user:anaconda:kyle/browser:tab",
            identityLabel: "Kyle",
          },
        })}
      />,
    );

    expect(screen.getByText("Kyle")).toBeVisible();
    expect(document.querySelector("[data-slot='notebook-identity-badge']")).toHaveAttribute(
      "data-variant",
      "inline",
    );
  });

  it("uses a compact label for inline email identities", () => {
    render(
      <NotebookToolbarIdentity
        variant="inline"
        capabilities={capabilities({
          access: {
            level: "owner",
            source: "cloud",
            isPublic: false,
            actorLabel: "user:anaconda:alice/browser:tab",
            identityLabel: "alice@example.com",
          },
        })}
      />,
    );

    expect(screen.getByText("alice")).toBeVisible();
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot='notebook-identity-badge']")).toHaveAttribute(
      "title",
      "alice@example.com - Owner",
    );
  });
});
