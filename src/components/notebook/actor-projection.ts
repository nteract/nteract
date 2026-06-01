import {
  friendlyNotebookActorLabel,
  friendlyNotebookOperatorLabel,
  parseNotebookActorLabel,
  parseNotebookOperatorLabel,
  splitNotebookActorPrincipalOperator,
} from "./actor-labels";
import type {
  NotebookActorIdentity,
  NotebookActorKind,
  NotebookActorOperator,
  NotebookActorPrincipal,
  NotebookActorProjection,
  NotebookShellAccessCapabilities,
  NotebookShellAuthCapabilities,
  NotebookShellRuntimeCapabilities,
} from "./capabilities";

export function notebookActorProjectionFromAccess(
  access: NotebookShellAccessCapabilities,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorProjection {
  if (access.actor) {
    return withAuthStatus(access.actor, auth);
  }

  const actorLabel = access.actorLabel ?? fallbackActorLabelForAccess(access);
  const [principalId, operatorId] = splitNotebookActorPrincipalOperator(actorLabel);
  const legacyProjection = parseNotebookActorLabel(access.actorLabel);
  const operator = operatorFromLabel(operatorId, access.source);
  const principalLabel =
    access.identityLabel ??
    legacyProjection?.onBehalfOf ??
    friendlyNotebookActorLabel(principalId) ??
    (access.isPublic ? "Public viewer" : "Unknown viewer");

  return withAuthStatus(
    {
      actorLabel,
      principal: {
        id: principalId,
        label: access.isPublic ? "Public viewer" : principalLabel,
        source: principalSource(principalId, access.source, access.isPublic),
      },
      operator:
        legacyProjection && (isLegacyAgentLabel(actorLabel) || !operatorId)
          ? legacyOperatorFromProjection(actorLabel, legacyProjection)
          : operator,
      scope: access.level === "none" ? undefined : access.level,
    },
    auth,
  );
}

export function notebookActorProjectionFromRuntime(
  runtime: NotebookShellRuntimeCapabilities,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorProjection | null {
  if (runtime.actor) {
    return withAuthStatus(runtime.actor, auth);
  }

  if (!runtime.connected && !runtime.actorLabel) {
    return null;
  }

  const actorLabel = runtime.actorLabel ?? fallbackActorLabelForRuntime(runtime);
  const [principalId, operatorId] = splitNotebookActorPrincipalOperator(actorLabel);
  const principalLabel =
    runtime.identityLabel ?? friendlyNotebookActorLabel(principalId) ?? "Runtime principal";

  return withAuthStatus(
    {
      actorLabel,
      principal: {
        id: principalId,
        label: principalLabel,
        source: principalSource(principalId, runtime.source, false),
      },
      operator: operatorFromLabel(operatorId, runtime.source, "runtime"),
      scope: runtime.canWriteRuntimeState ? "runtime_peer" : undefined,
    },
    auth,
  );
}

export interface NotebookActorProjectionFromLabelOptions {
  source?: NotebookShellAccessCapabilities["source"];
  scope?: NotebookActorProjection["scope"];
  identityLabel?: string | null;
  isPublic?: boolean;
  status?: NotebookActorProjection["status"];
}

export function notebookActorProjectionFromLabel(
  actorLabel: string,
  options: NotebookActorProjectionFromLabelOptions = {},
): NotebookActorProjection {
  const source = options.source ?? "unknown";
  const isPublic = options.isPublic ?? actorLabel.startsWith("anonymous:");
  const [principalId, operatorId] = splitNotebookActorPrincipalOperator(actorLabel);
  const legacyProjection = parseNotebookActorLabel(actorLabel);
  const principalLabel =
    options.identityLabel ??
    legacyProjection?.onBehalfOf ??
    friendlyNotebookActorLabel(principalId) ??
    (isPublic ? "Public viewer" : "Unknown viewer");

  return {
    actorLabel,
    principal: {
      id: principalId,
      label: isPublic ? "Public viewer" : principalLabel,
      source: principalSource(principalId, source, isPublic),
    },
    operator:
      legacyProjection && (isLegacyAgentLabel(actorLabel) || !operatorId)
        ? legacyOperatorFromProjection(actorLabel, legacyProjection)
        : operatorFromLabel(operatorId, source),
    scope: options.scope,
    status: options.status,
  };
}

export function notebookActorIdentityFromProjection(
  actor: NotebookActorProjection,
): NotebookActorIdentity {
  const kind = actorKindFromProjection(actor);
  const detail = actorDetailFromProjection(actor);

  return {
    id: actor.actorLabel,
    label: actorLabelFromProjection(actor, kind),
    detail,
    kind,
    imageUrl: actor.principal.imageUrl,
    status: actor.status ?? "active",
    principalLabel: actor.principal.label,
    operatorLabel: actor.operator.label,
  };
}

export function notebookActorIdentityFromAccess(
  access: NotebookShellAccessCapabilities,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorIdentity {
  return notebookActorIdentityFromProjection(notebookActorProjectionFromAccess(access, auth));
}

export function notebookActorIdentityFromRuntime(
  runtime: NotebookShellRuntimeCapabilities,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorIdentity | null {
  const projection = notebookActorProjectionFromRuntime(runtime, auth);
  return projection ? notebookActorIdentityFromProjection(projection) : null;
}

function withAuthStatus(
  actor: NotebookActorProjection,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorProjection {
  return {
    ...actor,
    status: auth?.needsAttention ? "attention" : (actor.status ?? "active"),
  };
}

function fallbackActorLabelForAccess(access: NotebookShellAccessCapabilities): string {
  if (access.isPublic) return "anonymous:public/browser:viewer";
  if (access.source === "local") return "local:desktop/desktop:app";
  return "unknown:viewer/browser:viewer";
}

function fallbackActorLabelForRuntime(runtime: NotebookShellRuntimeCapabilities): string {
  if (runtime.source === "local") return "local:desktop/runtime:local";
  return "unknown:runtime/runtime:unknown";
}

function operatorFromLabel(
  operatorId: string | null,
  source: NotebookShellAccessCapabilities["source"],
  fallbackKind?: string,
): NotebookActorOperator {
  const id = operatorId ?? fallbackOperatorId(source, fallbackKind);
  const kind = id.split(":").find(Boolean) ?? fallbackKind ?? "unknown";
  const parsedOperator = parseNotebookOperatorLabel(id, null);

  return {
    id,
    kind,
    label:
      parsedOperator?.label ?? friendlyNotebookOperatorLabel(id) ?? friendlyOperatorKindLabel(kind),
  };
}

function legacyOperatorFromProjection(
  actorLabel: string,
  projection: NonNullable<ReturnType<typeof parseNotebookActorLabel>>,
): NotebookActorOperator {
  return {
    id: actorLabel,
    kind: projection.kind,
    label: projection.label,
  };
}

function isLegacyAgentLabel(actorLabel: string): boolean {
  return actorLabel.startsWith("agent:");
}

function fallbackOperatorId(
  source: NotebookShellAccessCapabilities["source"],
  fallbackKind?: string,
): string {
  if (fallbackKind) return `${fallbackKind}:unknown`;
  if (source === "local") return "desktop:app";
  if (source === "cloud") return "browser:viewer";
  return "unknown:viewer";
}

function principalSource(
  principalId: string,
  source: NotebookShellAccessCapabilities["source"],
  isPublic: boolean,
): NotebookActorPrincipal["source"] {
  if (isPublic || principalId.startsWith("anonymous:")) {
    return { provider: "anonymous", namespace: "public" };
  }
  if (principalId.startsWith("local:")) {
    return { provider: "local", namespace: principalId.split(":")[1] ?? "desktop" };
  }
  if (principalId.startsWith("user:anaconda:")) {
    return { provider: "anaconda", namespace: "anaconda" };
  }
  if (principalId.startsWith("hub:")) {
    return { provider: "jupyterhub", namespace: principalId.split(":")[1] ?? "hub" };
  }
  if (source === "cloud") {
    return { provider: "oidc", namespace: "cloud" };
  }
  if (source === "local") {
    return { provider: "local", namespace: "desktop" };
  }
  return undefined;
}

function actorKindFromProjection(actor: NotebookActorProjection): NotebookActorKind {
  if (actor.operator.kind === "agent") return "agent";
  if (actor.operator.kind === "runtime") return "runtime";
  if (actor.operator.kind === "system" || actor.principal.id === "system") return "system";
  if (actor.principal.source?.provider === "anonymous") return "public";
  if (actor.principal.source?.provider === "local") return "local";
  if (actor.principal.id || actor.principal.label) return "human";
  return "unknown";
}

function actorLabelFromProjection(actor: NotebookActorProjection, kind: NotebookActorKind): string {
  if (kind === "agent" || kind === "runtime" || kind === "system") {
    return operatorActorLabel(actor);
  }
  return actor.principal.label;
}

function actorDetailFromProjection(actor: NotebookActorProjection): string | null {
  return accessScopeLabel(actor.scope);
}

function operatorActorLabel(actor: NotebookActorProjection): string {
  const principalLabel = actor.principal.label.trim();
  if (
    principalLabel &&
    principalLabel !== actor.operator.label &&
    !isGenericPrincipalLabel(principalLabel)
  ) {
    return `${actor.operator.label} for ${principalLabel}`;
  }
  return actor.operator.label;
}

function isGenericPrincipalLabel(label: string): boolean {
  return (
    label === "Runtime principal" ||
    label === "Unknown viewer" ||
    label === "Public viewer" ||
    label === "System" ||
    label === "Peer"
  );
}

function accessScopeLabel(scope: NotebookActorProjection["scope"]): string | null {
  switch (scope) {
    case "viewer":
      return "Viewer";
    case "editor":
      return "Editor";
    case "owner":
      return "Owner";
    case "runtime_peer":
      return "Runtime peer";
    case undefined:
      return null;
  }
}

function friendlyOperatorKindLabel(kind: string): string {
  const parsed = parseNotebookActorLabel(`${kind}:unknown`);
  return (
    parsed?.label ?? kind.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}
