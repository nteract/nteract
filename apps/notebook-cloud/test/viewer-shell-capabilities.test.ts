import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudNotebookShellCapabilities } from "../viewer/shell-capabilities";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";

function authState(
  mode: CloudPrototypeAuthState["mode"],
  requestedScope: CloudPrototypeAuthState["requestedScope"] = null,
  oidcClaims: CloudPrototypeAuthState["oidcClaims"] = null,
): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "anonymous" ? null : "token",
    user: mode === "anonymous" ? null : "user@example.test",
    oidcClaims,
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
  assert.equal(capabilities.interaction?.selectedMode, "view");
  assert.equal(capabilities.interaction?.activeMode, "view");
  assert.equal(capabilities.interaction?.state, "viewing");
  assert.equal(capabilities.access.level, "viewer");
  assert.equal(capabilities.access.source, "cloud");
  assert.equal(capabilities.access.isPublic, true);
  assert.equal(capabilities.access.actor?.principal.label, "Public viewer");
  assert.equal(capabilities.access.actor?.principal.source?.provider, "anonymous");
  assert.equal(capabilities.access.actor?.operator.kind, "browser");
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities grant editors full cell and structure editing without execute or package management", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: false,
    selectedMode: "edit",
  });

  assert.equal(capabilities.canEditMarkdown, true);
  assert.equal(capabilities.canEditCells, true);
  assert.equal(capabilities.canEditStructure, true);
  assert.equal(capabilities.canRequestEdit, true);
  assert.equal(capabilities.canExecute, false);
  assert.equal(capabilities.canToggleCode, false);
  assert.equal(capabilities.canManagePackages, false);
  assert.equal(capabilities.interaction?.selectedMode, "edit");
  assert.equal(capabilities.interaction?.activeMode, "edit");
  assert.equal(capabilities.interaction?.state, "editing");
  assert.equal(capabilities.access.level, "editor");
  assert.equal(capabilities.access.identityLabel, "user");
  assert.equal(capabilities.access.actor?.principal.label, "user");
  assert.equal(capabilities.access.actor?.principal.source?.provider, "oidc");
  assert.equal(capabilities.access.actor?.operator.kind, "browser");
  assert.equal(capabilities.auth.canUseAuthenticatedIdentity, true);
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities wait for host mutation support before activating editor mode", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: true,
    selectedMode: "edit",
    canAcceptCellMutations: false,
  });

  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.interaction?.selectedMode, "edit");
  assert.equal(capabilities.interaction?.activeMode, "view");
  assert.equal(capabilities.interaction?.state, "requested");
  assert.equal(capabilities.access.level, "editor");
});

test("cloud shell capabilities surface execution only when a runtime is available", () => {
  const withoutRuntime = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
    selectedMode: "edit",
  });
  assert.equal(withoutRuntime.runtime.executionAvailable, false);
  assert.equal(withoutRuntime.runtime.connected, false);
  assert.equal(withoutRuntime.runtime.target?.label, "No workstation attached");
  assert.equal(withoutRuntime.runtime.target?.status, "offline");
  assert.equal(withoutRuntime.canExecute, false);

  const withRuntime = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
    selectedMode: "edit",
    runtimeAvailable: true,
  });
  assert.equal(withRuntime.runtime.executionAvailable, true);
  assert.equal(withRuntime.runtime.connected, true);
  assert.equal(withRuntime.runtime.target?.label, "Room workstation");
  assert.equal(withRuntime.runtime.target?.status, "ready");
  assert.equal(withRuntime.canExecute, true);

  // A live runtime is visible to viewers, but viewing is not execution authority.
  const viewerWithRuntime = cloudNotebookShellCapabilities({
    authState: authState("oidc", "viewer"),
    connectionScope: "viewer",
    hasCodeCells: true,
    runtimeAvailable: true,
  });
  assert.equal(viewerWithRuntime.runtime.executionAvailable, true);
  assert.equal(viewerWithRuntime.runtime.connected, true);
  assert.equal(viewerWithRuntime.runtime.target?.label, "Room workstation");
  assert.equal(viewerWithRuntime.canExecute, false);

  // Runtime presence is visible to editors too, but the room host grants
  // execution-intent authority to owner scope until an explicit execute scope
  // is defined.
  const editorWithRuntime = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: true,
    selectedMode: "edit",
    runtimeAvailable: true,
  });
  assert.equal(editorWithRuntime.runtime.executionAvailable, true);
  assert.equal(editorWithRuntime.runtime.connected, true);
  assert.equal(editorWithRuntime.runtime.target?.label, "Room workstation");
  assert.equal(editorWithRuntime.canExecute, false);
});

test("cloud shell capabilities keep user-selected view mode read-only even with editor access", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: true,
    selectedMode: "view",
  });

  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.interaction?.selectedMode, "view");
  assert.equal(capabilities.interaction?.activeMode, "view");
  assert.equal(capabilities.interaction?.state, "viewing");
  assert.equal(capabilities.access.level, "editor");
  assert.equal(capabilities.canToggleCode, true);
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities keep selected mode separate from requested auth scope", () => {
  const viewerMode = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "editor",
    hasCodeCells: true,
    selectedMode: "view",
  });
  const editorMode = cloudNotebookShellCapabilities({
    authState: authState("oidc", "viewer"),
    connectionScope: "editor",
    hasCodeCells: true,
    selectedMode: "edit",
  });

  assert.equal(viewerMode.access.level, "editor");
  assert.equal(viewerMode.interaction?.selectedMode, "view");
  assert.equal(viewerMode.interaction?.activeMode, "view");
  assert.equal(viewerMode.canEditMarkdown, false);

  assert.equal(editorMode.access.level, "editor");
  assert.equal(editorMode.interaction?.selectedMode, "edit");
  assert.equal(editorMode.interaction?.activeMode, "edit");
  assert.equal(editorMode.canEditMarkdown, true);
});

test("cloud shell capabilities keep requested edit pending until the room grants edit access", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "viewer",
    hasCodeCells: true,
    selectedMode: "edit",
  });

  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canRequestEdit, true);
  assert.equal(capabilities.interaction?.selectedMode, "edit");
  assert.equal(capabilities.interaction?.activeMode, "view");
  assert.equal(capabilities.interaction?.state, "requested");
  assert.equal(capabilities.access.level, "viewer");
});

test("cloud shell capabilities suppress editor mode while a requested edit reconnect is pending", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor"),
    connectionScope: "viewer",
    hasCodeCells: true,
    selectedMode: "edit",
    canAcceptCellMutations: false,
    editAccessRequestPending: true,
  });

  assert.equal(capabilities.canEditMarkdown, false);
  assert.equal(capabilities.canEditCells, false);
  assert.equal(capabilities.canEditStructure, false);
  assert.equal(capabilities.canRequestEdit, true);
  assert.equal(capabilities.interaction?.selectedMode, "view");
  assert.equal(capabilities.interaction?.activeMode, "view");
  assert.equal(capabilities.interaction?.state, "viewing");
});

test("cloud shell capabilities grant owners full cell, structure, and sharing control", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
    selectedMode: "edit",
    hostCapabilities: { canManageSharing: true },
  });

  assert.equal(capabilities.canEditMarkdown, true);
  assert.equal(capabilities.canEditCells, true);
  assert.equal(capabilities.canEditStructure, true);
  assert.equal(capabilities.canExecute, false);
  assert.equal(capabilities.canManagePackages, false);
  assert.equal(capabilities.canManageSharing, true);
  assert.equal(capabilities.interaction?.selectedMode, "edit");
  assert.equal(capabilities.interaction?.activeMode, "edit");
  assert.equal(capabilities.interaction?.state, "editing");
  assert.equal(capabilities.access.level, "owner");
  assert.equal(capabilities.runtime.canWriteRuntimeState, false);
});

test("cloud shell capabilities surface sharing for authenticated hosted rooms", () => {
  assert.equal(
    cloudNotebookShellCapabilities({
      authState: authState("dev"),
      connectionScope: "owner",
      hasCodeCells: true,
      hostCapabilities: { canManageSharing: true },
    }).canManageSharing,
    true,
  );

  assert.equal(
    cloudNotebookShellCapabilities({
      authState: authState("dev"),
      connectionScope: "editor",
      hasCodeCells: true,
      hostCapabilities: { canManageSharing: true },
    }).canManageSharing,
    true,
  );

  assert.equal(
    cloudNotebookShellCapabilities({
      authState: authState("anonymous"),
      connectionScope: "viewer",
      hasCodeCells: true,
      hostCapabilities: { canManageSharing: true },
    }).canManageSharing,
    false,
  );
});

test("cloud shell capabilities require the host room to advertise sharing", () => {
  const ownerWithoutSharingHost = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
  });
  assert.equal(ownerWithoutSharingHost.canManageSharing, false);

  const expiredOwnerWithSharingHost = cloudNotebookShellCapabilities({
    authState: authState("oidc_expired", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
    hostCapabilities: { canManageSharing: true },
  });
  assert.equal(expiredOwnerWithSharingHost.canManageSharing, false);
});

test("cloud shell capabilities expose interaction mode for local dev identities", () => {
  const owner = cloudNotebookShellCapabilities({
    authState: authState("dev", "owner"),
    connectionScope: "owner",
    hasCodeCells: true,
    selectedMode: "edit",
  });
  assert.equal(owner.canRequestEdit, true);
  assert.equal(owner.interaction?.activeMode, "edit");
  assert.equal(owner.interaction?.state, "editing");

  const viewerRequest = cloudNotebookShellCapabilities({
    authState: authState("dev", "viewer"),
    connectionScope: "viewer",
    hasCodeCells: true,
    selectedMode: "edit",
  });
  assert.equal(viewerRequest.canRequestEdit, true);
  assert.equal(viewerRequest.interaction?.activeMode, "view");
  assert.equal(viewerRequest.interaction?.state, "requested");
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
  assert.equal(capabilities.access.identityLabel, "user");
  assert.equal(capabilities.access.actor?.actorLabel, "user:anaconda:alice/browser:tab");
  assert.equal(capabilities.access.actor?.principal.label, "user");
});

test("cloud shell capabilities prefer OIDC display names and pictures over raw emails", () => {
  const capabilities = cloudNotebookShellCapabilities({
    authState: authState("oidc", "editor", {
      sub: "anaconda-user-123",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice Example",
      picture: "https://profiles.example/alice.png",
    }),
    connectionScope: "editor",
    connectionActorLabel: "user:anaconda:alice/browser:tab",
    hasCodeCells: false,
    selectedMode: "edit",
  });

  assert.equal(capabilities.access.identityLabel, "Alice Example");
  assert.equal(capabilities.access.actor?.principal.label, "Alice Example");
  assert.equal(capabilities.access.actor?.principal.imageUrl, "https://profiles.example/alice.png");
});

test("cloud shell capabilities return stable frozen objects for equivalent inputs", () => {
  const oidcClaims = {
    sub: "anaconda-user-123",
    email: "alice@example.com",
    email_verified: true,
    name: "Alice Example",
    picture: "https://profiles.example/alice.png",
  };
  const first = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner", oidcClaims),
    connectionScope: "owner",
    connectionActorLabel: "user:anaconda:alice/browser:tab",
    hasCodeCells: true,
    selectedMode: "edit",
    runtimeAvailable: true,
    hostCapabilities: { canManageSharing: true },
  });
  const second = cloudNotebookShellCapabilities({
    authState: authState("oidc", "owner", { ...oidcClaims }),
    connectionScope: "owner",
    connectionActorLabel: "user:anaconda:alice/browser:tab",
    hasCodeCells: true,
    selectedMode: "edit",
    runtimeAvailable: true,
    hostCapabilities: { canManageSharing: true },
  });

  assert.equal(first, second);
  assert.equal(first.access, second.access);
  assert.equal(first.auth, second.auth);
  assert.equal(first.runtime, second.runtime);
  assert.equal(first.runtime.target, second.runtime.target);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.access), true);
  assert.equal(Object.isFrozen(first.runtime), true);
  assert.equal(Object.isFrozen(first.runtime.target), true);
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
  assert.equal(capabilities.runtime.identityLabel, "user");
  assert.equal(capabilities.runtime.actor?.scope, "runtime_peer");
  assert.equal(capabilities.runtime.target?.kind, "runtime_peer");
  assert.equal(capabilities.runtime.target?.status, "attached");
  assert.equal(capabilities.runtime.target?.label, "Runtime peer");
  assert.equal(capabilities.runtime.actor?.principal.label, "user");
  assert.equal(capabilities.runtime.actor?.operator.kind, "runtime");
  assert.equal(capabilities.runtime.actor?.operator.label, "JupyterHub");
});
