export type ParsedNotebookActorKind = "agent" | "runtime" | "system";

export interface ParsedNotebookActorLabel {
  kind: ParsedNotebookActorKind;
  label: string;
  onBehalfOf: string | null;
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
