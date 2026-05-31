import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudNotebookShellCapabilities } from "../viewer/shell-capabilities";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";

function authState(
  mode: CloudPrototypeAuthState["mode"],
  requestedScope: CloudPrototypeAuthState["requestedScope"] = null,
): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "anonymous" ? null : "token",
    user: mode === "anonymous" ? null : "user@example.test",
    oidcClaims: null,
    requestedScope,
    problem: mode === "invalid" || mode === "oidc_expired" ? "auth problem" : null,
  };
}

test("cloud shell capabilities keep viewer scope read-only", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("anonymous"),
    connectionScope: "viewer",
    hasCodeCells: true,
  });

  assert.equal(capabilities.canRead, true);
  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canRequestEdit, false);
  assert.equal(capabilities.canExecute, false);
  assert.equal(capabilities.canToggleCode, true);
  assert.equal(capabilities.canManageSharing, false);
  assert.equal(capabilities.access.level, "viewer");
  assert.equal(capabilities.access.source, "cloud");
  assert.equal(capabilities.access.isPublic, true);
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities grant editor markdown writes without code, structure, execute, or package management", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: false,
  });

  assert.equal(capabilities.canEditMarkdown, true);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canRequestEdit, true);
  assert.equal(capabilities.canExecute, false);
  assert.equal(capabilities.canToggleCode, false);
  assert.equal(capabilities.canManagePackages, false);
  assert.equal(capabilities.access.level, "editor");
  assert.equal(capabilities.access.identityLabel, "user@example.test");
  assert.equal(capabilities.auth.canUseAuthenticatedIdentity, true);
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities keep user-selected view mode read-only even with editor access", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "viewer"),
    connectionScope: "editor",
    hasCodeCells: true,
  });

  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.access.level, "editor");
  assert.equal(capabilities.canToggleCode, true);
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities reserve code-cell source edits for owners", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
  });

  assert.equal(capabilities.canEditMarkdown, true);
  assert.equal(capabilities.canEditCells, true);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canExecute, false);
  assert.equal(capabilities.canManagePackages, false);
  assert.equal(capabilities.canManageSharing, true);
  assert.equal(capabilities.access.level, "owner");
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities reserve sharing for owners", () => {
  assert.equal(
    cloudNotebookShellCapabilities({
      authState: authState("dev"),
      connectionScope: "owner",
      hasCodeCells: true,
    }).canManageSharing,
    true,
  );

  assert.equal(
    cloudNotebookShellCapabilities({
      authState: authState("dev"),
      connectionScope: "editor",
      hasCodeCells: true,
    }).canManageSharing,
    false,
  );
});

test("cloud shell capabilities expose expired auth attention", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc_expired"),
    connectionScope: "viewer",
    hasCodeCells: false,
  });

  assert.equal(capabilities.auth.needsAttention, true);
  assert.equal(capabilities.auth.canUseAuthenticatedIdentity, false);
  assert.equal(capabilities.auth.canSignIn, true);
  assert.equal(capabilities.runtime.connected, false);
});

test("cloud shell capabilities preserve room actor labels for shared access UI", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc"),
    connectionScope: "owner",
    connectionActorLabel: "user:anaconda:alice/browser:tab",
    hasCodeCells: false,
  });

  assert.equal(capabilities.access.level, "owner");
  assert.equal(capabilities.access.actorLabel, "user:anaconda:alice/browser:tab");
  assert.equal(capabilities.access.identityLabel, "user@example.test");
});

test("cloud shell capabilities keep runtime peer authority separate from document access", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc"),
    connectionScope: "runtime_peer",
    connectionActorLabel: "user:anaconda:alice/runtime:jupyterhub",
    hasCodeCells: true,
  });

  assert.equal(capabilities.access.level, "viewer");
  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canManageSharing, false);
  assert.equal(capabilities.runtime.canWriteRuntimeState, true);
  assert.equal(capabilities.runtime.connected, true);
  assert.equal(capabilities.runtime.source, "cloud");
  assert.equal(capabilities.runtime.actorLabel, "user:anaconda:alice/runtime:jupyterhub");
  assert.equal(capabilities.runtime.identityLabel, "user@example.test");
});
