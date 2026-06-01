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
    expect(actors[0]?.label).toBe("JupyterHub");
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
    expect(actors.map((actor) => actor.label)).toEqual(["Codex", "Python"]);
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
    expect(screen.getByText("JupyterHub")).toBeVisible();
  });
});
