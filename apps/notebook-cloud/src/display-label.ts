export interface IdentityDisplayLabelInput {
  displayName?: string | null;
  email?: string | null;
  principal: string;
}

export function identityDisplayLabel(input: IdentityDisplayLabelInput): string {
  const displayName = input.displayName?.trim();
  if (displayName) return displayName;

  const email = input.email?.trim();
  if (email) return email;

  return compactPrincipalLabel(input.principal);
}

export function compactPrincipalLabel(value: string): string {
  const principal = value.split("/")[0]?.trim() || value.trim();
  if (!principal) return "User";
  if (principal.startsWith("anonymous:")) return "Anonymous";

  const userMatch = principal.match(/^user:([^:]+):(.+)$/);
  if (!userMatch) return principal;

  const namespace = safeDecode(userMatch[1] ?? "");
  const subject = safeDecode(userMatch[2] ?? "").trim();
  if (!subject) return providerUserLabel(namespace);
  if (looksLikeEmail(subject)) return subject;
  if (namespace === "dev") return subject;

  return `${providerUserLabel(namespace)} ${shortSubject(subject)}`;
}

function providerUserLabel(namespace: string): string {
  switch (namespace) {
    case "anaconda":
      return "Anaconda user";
    case "oidc":
      return "OIDC user";
    default:
      return `${titleCase(namespace)} user`;
  }
}

function shortSubject(subject: string): string {
  const normalized = subject.replace(/[^A-Za-z0-9._-]+/g, "").trim();
  return (normalized || subject).slice(0, 8);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleCase(value: string): string {
  const normalized = value.replace(/[-_]+/g, " ").trim();
  if (!normalized) return "User";
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}
