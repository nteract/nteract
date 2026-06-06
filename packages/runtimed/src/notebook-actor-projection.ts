import type {
  NotebookShellAccessCapabilities,
  NotebookShellAccessSource,
  NotebookShellAuthCapabilities,
  NotebookShellRuntimeCapabilities,
} from "./notebook-shell-capabilities";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type ParsedNotebookActorKind = "agent" | "runtime" | "system";

export interface ParsedNotebookActorLabel {
  kind: ParsedNotebookActorKind;
  label: string;
  onBehalfOf: string | null;
}

export type NotebookActorSourceProvider =
  | "anonymous"
  | "anaconda"
  | "dev"
  | "jupyterhub"
  | "local"
  | "outerbounds"
  | "oidc";

export interface NotebookActorPrincipal {
  id: string;
  label: string;
  imageUrl?: string | null;
  source?: {
    provider: NotebookActorSourceProvider;
    namespace: string;
  };
}

export interface NotebookActorOperator {
  id: string;
  kind: string;
  label: string;
}

export interface NotebookActorProjection {
  actorLabel: string;
  principal: NotebookActorPrincipal;
  operator: NotebookActorOperator;
  scope?: "viewer" | "editor" | "runtime_peer" | "owner";
  status?: "active" | "attention" | "idle" | "offline";
}

export type NotebookActorKind =
  | "agent"
  | "human"
  | "local"
  | "public"
  | "runtime"
  | "system"
  | "unknown";

export interface NotebookActorIdentity {
  id: string;
  label: string;
  detail: string | null;
  kind: NotebookActorKind;
  imageUrl?: string | null;
  status?: "active" | "attention" | "idle" | "offline";
  principalLabel?: string | null;
  operatorLabel?: string | null;
}

export interface NotebookActorProjectionFromLabelOptions {
  source?: NotebookShellAccessSource;
  scope?: NotebookActorProjection["scope"];
  identityLabel?: string | null;
  identityImageUrl?: string | null;
  isPublic?: boolean;
  status?: NotebookActorProjection["status"];
}

type NotebookActorPrincipalSource = NonNullable<NotebookActorPrincipal["source"]>;

const ACTOR_PROJECTION_CACHE = new Map<string, NotebookActorProjection>();
let ACTOR_IDENTITY_CACHE = new WeakMap<NotebookActorProjection, NotebookActorIdentity>();
let ACTIVE_ACTOR_CACHE = new WeakMap<NotebookActorProjection, NotebookActorProjection>();
let ATTENTION_ACTOR_CACHE = new WeakMap<NotebookActorProjection, NotebookActorProjection>();
let PRINCIPAL_IMAGE_CACHE = new WeakMap<
  NotebookActorProjection,
  Map<string, NotebookActorProjection>
>();
const PRINCIPAL_SOURCE_CACHE = new Map<string, NotebookActorPrincipalSource>();
const PRINCIPAL_CACHE = new Map<string, NotebookActorPrincipal>();
const OPERATOR_CACHE = new Map<string, NotebookActorOperator>();
const ACTOR_PROJECTION_CACHE_LIMIT = 512;
const ACTOR_PART_CACHE_LIMIT = 512;
const ACTOR_IMAGE_CACHE_LIMIT = 8;

export function clearNotebookActorProjectionCachesForTests(): void {
  ACTOR_PROJECTION_CACHE.clear();
  ACTOR_IDENTITY_CACHE = new WeakMap();
  ACTIVE_ACTOR_CACHE = new WeakMap();
  ATTENTION_ACTOR_CACHE = new WeakMap();
  PRINCIPAL_IMAGE_CACHE = new WeakMap();
  PRINCIPAL_SOURCE_CACHE.clear();
  PRINCIPAL_CACHE.clear();
  OPERATOR_CACHE.clear();
}

export function parseNotebookActorLabel(
  actorLabel: string | null | undefined,
): ParsedNotebookActorLabel | null {
  if (!actorLabel) return null;

  const [principal, operator] = splitNotebookActorPrincipalOperator(actorLabel);
  const operatorProjection = operator ? parseNotebookOperatorLabel(operator, principal) : null;
  if (operatorProjection) return operatorProjection;

  if (principal === "system" && operator) {
    return {
      kind: "system",
      label: friendlyNotebookOperatorLabel(operator) ?? "System",
      onBehalfOf: null,
    };
  }

  if (actorLabel.startsWith("agent:")) {
    const agentValue = actorLabel.slice("agent:".length);
    const [rawAgent, rawBehalf] = agentValue.split("/on-behalf-of:");
    return {
      kind: "agent",
      label: friendlyNotebookActorLabel(rawAgent) ?? "Agent",
      onBehalfOf: friendlyNotebookActorLabel(rawBehalf ?? null),
    };
  }

  return parseNotebookOperatorLabel(actorLabel, null);
}

export function parseNotebookOperatorLabel(
  operatorLabel: string,
  principalLabel: string | null,
): ParsedNotebookActorLabel | null {
  if (operatorLabel.startsWith("agent:")) {
    return {
      kind: "agent",
      label: friendlyNotebookOperatorLabel(operatorLabel.slice("agent:".length)) ?? "Agent",
      onBehalfOf: friendlyNotebookActorLabel(principalLabel),
    };
  }

  if (operatorLabel.startsWith("runtime:")) {
    return {
      kind: "runtime",
      label: friendlyNotebookOperatorLabel(operatorLabel.slice("runtime:".length)) ?? "Runtime",
      onBehalfOf: friendlyNotebookActorLabel(principalLabel),
    };
  }

  if (operatorLabel.startsWith("system:")) {
    return {
      kind: "system",
      label: friendlyNotebookOperatorLabel(operatorLabel.slice("system:".length)) ?? "System",
      onBehalfOf: friendlyNotebookActorLabel(principalLabel),
    };
  }

  return null;
}

export function splitNotebookActorPrincipalOperator(
  actorLabel: string,
): [principal: string, operator: string | null] {
  const separatorIndex = actorLabel.indexOf("/");
  if (separatorIndex === -1) {
    return [actorLabel, null];
  }
  return [actorLabel.slice(0, separatorIndex), actorLabel.slice(separatorIndex + 1)];
}

export function friendlyNotebookActorLabel(actorLabel: string | null | undefined): string | null {
  const trimmed = actorLabel?.trim();
  if (!trimmed) return null;

  const [principal] = splitNotebookActorPrincipalOperator(trimmed);

  if (principal.startsWith("anonymous:")) {
    return "Anonymous";
  }

  if (principal.startsWith("user:")) {
    return friendlyUserPrincipalLabel(principal);
  }

  if (principal === "system") {
    return "System";
  }

  const lastSegment = principal.split(/[/:]/).filter(Boolean).at(-1) ?? principal;
  return humanizeActorSegment(lastSegment);
}

export function friendlyNotebookOperatorLabel(
  operatorLabel: string | null | undefined,
): string | null {
  const trimmed = operatorLabel?.trim();
  if (!trimmed) return null;

  const firstSegment = trimmed.split(":").find(Boolean) ?? trimmed;
  return friendlyNotebookActorLabel(firstSegment);
}

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

  return cachedNotebookActorProjection({
    actorLabel,
    principalId,
    principalLabel: access.isPublic ? "Public viewer" : principalLabel,
    principalSource: principalSource(principalId, access.source, access.isPublic),
    operator:
      legacyProjection && (isLegacyAgentLabel(actorLabel) || !operatorId)
        ? legacyOperatorFromProjection(actorLabel, legacyProjection)
        : operator,
    scope: access.level === "none" ? undefined : access.level,
    status: auth?.needsAttention ? "attention" : "active",
  });
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

  return cachedNotebookActorProjection({
    actorLabel,
    principalId,
    principalLabel,
    principalSource: principalSource(principalId, runtime.source, false),
    operator: operatorFromLabel(operatorId, runtime.source, "runtime"),
    scope: runtime.canWriteRuntimeState ? "runtime_peer" : undefined,
    status: auth?.needsAttention ? "attention" : "active",
  });
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

  return cachedNotebookActorProjection({
    actorLabel,
    principalId,
    principalLabel: isPublic ? "Public viewer" : principalLabel,
    principalSource: principalSource(principalId, source, isPublic),
    identityImageUrl: options.identityImageUrl,
    operator:
      legacyProjection && (isLegacyAgentLabel(actorLabel) || !operatorId)
        ? legacyOperatorFromProjection(actorLabel, legacyProjection)
        : operatorFromLabel(operatorId, source),
    scope: options.scope,
    status: options.status,
  });
}

export function notebookActorProjectionWithPrincipalImage(
  actor: NotebookActorProjection | null,
  imageUrl: string | null | undefined,
): NotebookActorProjection | null {
  const trimmedImageUrl = imageUrl?.trim() || null;
  if (!actor || !trimmedImageUrl || actor.principal.imageUrl === trimmedImageUrl) {
    return actor;
  }

  let imageCache = PRINCIPAL_IMAGE_CACHE.get(actor);
  if (!imageCache) {
    imageCache = new Map();
    PRINCIPAL_IMAGE_CACHE.set(actor, imageCache);
  }
  const cached = getBoundedCacheValue(imageCache, trimmedImageUrl);
  if (cached) return cached;

  const projection = Object.freeze({
    ...actor,
    principal: stableNotebookActorPrincipal(
      actor.principal.id,
      actor.principal.label,
      actor.principal.source,
      trimmedImageUrl,
    ),
  });
  setBoundedCacheValue(imageCache, trimmedImageUrl, projection, ACTOR_IMAGE_CACHE_LIMIT);
  return projection;
}

export function notebookActorIdentityFromProjection(
  actor: NotebookActorProjection,
): NotebookActorIdentity {
  const cached = ACTOR_IDENTITY_CACHE.get(actor);
  if (cached) return cached;

  const kind = actorKindFromProjection(actor);
  const detail = actorDetailFromProjection(actor);
  const identity = Object.freeze({
    id: actor.actorLabel,
    label: actorLabelFromProjection(actor, kind),
    detail,
    kind,
    imageUrl: actor.principal.imageUrl,
    status: actor.status ?? "active",
    principalLabel: actor.principal.label,
    operatorLabel: actor.operator.label,
  });

  ACTOR_IDENTITY_CACHE.set(actor, identity);
  return identity;
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

function cachedNotebookActorProjection({
  actorLabel,
  principalId,
  principalLabel,
  principalSource,
  identityImageUrl,
  operator,
  scope,
  status,
}: {
  actorLabel: string;
  principalId: string;
  principalLabel: string;
  principalSource: NotebookActorPrincipal["source"];
  identityImageUrl?: string | null;
  operator: NotebookActorOperator;
  scope: NotebookActorProjection["scope"];
  status: NotebookActorProjection["status"];
}): NotebookActorProjection {
  const cacheKey = stableCacheKey([
    actorLabel,
    principalId,
    principalLabel,
    principalSource?.provider,
    principalSource?.namespace,
    identityImageUrl?.trim() || null,
    operator.id,
    operator.kind,
    operator.label,
    scope,
    status,
  ]);
  const cached = getBoundedCacheValue(ACTOR_PROJECTION_CACHE, cacheKey);
  if (cached) return cached;

  const projection = Object.freeze({
    actorLabel,
    principal: stableNotebookActorPrincipal(
      principalId,
      principalLabel,
      principalSource,
      identityImageUrl,
    ),
    operator: stableNotebookActorOperator(operator.id, operator.kind, operator.label),
    scope,
    status,
  });

  setBoundedCacheValue(ACTOR_PROJECTION_CACHE, cacheKey, projection, ACTOR_PROJECTION_CACHE_LIMIT);
  return projection;
}

function stableNotebookActorPrincipal(
  id: string,
  label: string,
  source: NotebookActorPrincipal["source"],
  imageUrl?: string | null,
): NotebookActorPrincipal {
  const stableSource = source
    ? stableNotebookActorPrincipalSource(source.provider, source.namespace)
    : undefined;
  const stableImageUrl = imageUrl?.trim() || null;
  const cacheKey = stableCacheKey([
    id,
    label,
    stableSource?.provider,
    stableSource?.namespace,
    stableImageUrl,
  ]);
  const cached = getBoundedCacheValue(PRINCIPAL_CACHE, cacheKey);
  if (cached) return cached;

  const principal = Object.freeze({
    id,
    label,
    ...(stableImageUrl ? { imageUrl: stableImageUrl } : {}),
    ...(stableSource ? { source: stableSource } : {}),
  });
  setBoundedCacheValue(PRINCIPAL_CACHE, cacheKey, principal, ACTOR_PART_CACHE_LIMIT);
  return principal;
}

function stableNotebookActorPrincipalSource(
  provider: NotebookActorSourceProvider,
  namespace: string,
): NotebookActorPrincipalSource {
  const cacheKey = stableCacheKey([provider, namespace]);
  const cached = getBoundedCacheValue(PRINCIPAL_SOURCE_CACHE, cacheKey);
  if (cached) return cached;

  const source = Object.freeze({ provider, namespace });
  setBoundedCacheValue(PRINCIPAL_SOURCE_CACHE, cacheKey, source, ACTOR_PART_CACHE_LIMIT);
  return source;
}

function stableNotebookActorOperator(
  id: string,
  kind: string,
  label: string,
): NotebookActorOperator {
  const cacheKey = stableCacheKey([id, kind, label]);
  const cached = getBoundedCacheValue(OPERATOR_CACHE, cacheKey);
  if (cached) return cached;

  const operator = Object.freeze({ id, kind, label });
  setBoundedCacheValue(OPERATOR_CACHE, cacheKey, operator, ACTOR_PART_CACHE_LIMIT);
  return operator;
}

function withAuthStatus(
  actor: NotebookActorProjection,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorProjection {
  const requiredStatus = auth?.needsAttention ? "attention" : (actor.status ?? "active");
  if (actor.status === requiredStatus) {
    return actor;
  }

  const statusCache = requiredStatus === "attention" ? ATTENTION_ACTOR_CACHE : ACTIVE_ACTOR_CACHE;
  const cached = statusCache.get(actor);
  if (cached) return cached;

  const statusActor = Object.freeze({
    ...actor,
    status: requiredStatus,
  });
  statusCache.set(actor, statusActor);
  return statusActor;
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
  source: NotebookShellAccessSource,
  fallbackKind?: string,
): NotebookActorOperator {
  const id = operatorId ?? fallbackOperatorId(source, fallbackKind);
  const kind = id.split(":").find(Boolean) ?? fallbackKind ?? "unknown";
  const parsedOperator = parseNotebookOperatorLabel(id, null);

  return stableNotebookActorOperator(
    id,
    kind,
    parsedOperator?.label ?? friendlyNotebookOperatorLabel(id) ?? friendlyOperatorKindLabel(kind),
  );
}

function legacyOperatorFromProjection(
  actorLabel: string,
  projection: NonNullable<ReturnType<typeof parseNotebookActorLabel>>,
): NotebookActorOperator {
  return stableNotebookActorOperator(actorLabel, projection.kind, projection.label);
}

function isLegacyAgentLabel(actorLabel: string): boolean {
  return actorLabel.startsWith("agent:");
}

function fallbackOperatorId(source: NotebookShellAccessSource, fallbackKind?: string): string {
  if (fallbackKind) return `${fallbackKind}:unknown`;
  if (source === "local") return "desktop:app";
  if (source === "cloud") return "browser:viewer";
  return "unknown:viewer";
}

function principalSource(
  principalId: string,
  source: NotebookShellAccessSource,
  isPublic: boolean,
): NotebookActorPrincipal["source"] {
  if (isPublic || principalId.startsWith("anonymous:")) {
    return stableNotebookActorPrincipalSource("anonymous", "public");
  }
  if (principalId.startsWith("local:")) {
    return stableNotebookActorPrincipalSource("local", principalId.split(":")[1] ?? "desktop");
  }
  if (principalId.startsWith("user:anaconda:")) {
    return stableNotebookActorPrincipalSource("anaconda", "anaconda");
  }
  if (principalId.startsWith("hub:")) {
    return stableNotebookActorPrincipalSource("jupyterhub", principalId.split(":")[1] ?? "hub");
  }
  if (source === "cloud") {
    return stableNotebookActorPrincipalSource("oidc", "cloud");
  }
  if (source === "local") {
    return stableNotebookActorPrincipalSource("local", "desktop");
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

function friendlyUserPrincipalLabel(principal: string): string {
  const parts = principal.split(":");
  const namespace = parts.slice(0, 2).join(":");
  const encodedSubject = parts.slice(2).join(":");
  const subject = safeDecodeActorSegment(encodedSubject);
  if (!subject) {
    return namespace === "user:anaconda" ? "Anaconda user" : "User";
  }
  if (subject.includes("@")) {
    return subject;
  }
  if (namespace === "user:anaconda" && looksOpaqueSubject(subject)) {
    return "Anaconda user";
  }

  return humanizeActorSegment(subject);
}

function humanizeActorSegment(segment: string): string {
  const decoded = safeDecodeActorSegment(segment);
  if (decoded.includes("@")) {
    return decoded;
  }
  const knownLabel = knownActorLabel(decoded);
  if (knownLabel) return knownLabel;
  return decoded.replace(/[-_]+/g, " ").replace(/\b\w/g, titleCaseChar).trim();
}

function safeDecodeActorSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function titleCaseChar(char: string): string {
  return char.toUpperCase();
}

function looksOpaqueSubject(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function knownActorLabel(label: string): string | null {
  switch (label.toLowerCase()) {
    case "codex":
      return "Codex";
    case "jupyterhub":
      return "JupyterHub";
    default:
      return null;
  }
}
