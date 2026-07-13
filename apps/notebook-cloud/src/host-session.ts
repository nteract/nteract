import {
  encodePrincipalComponent,
  validatePrincipal,
  type AuthenticatedConnection,
} from "./identity.ts";

export const HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1 = "oidc-userinfo-v1";
export const HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1 = "anaconda-whoami-v1";

export type HostSessionIdentityAdapter =
  | typeof HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1
  | typeof HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1;

export interface HostSessionEnvironment {
  NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_ADAPTER?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE?: string;
}

export interface HostSessionIdentity {
  subject: string;
  displayName?: string;
  avatarUrl?: string;
  email?: {
    value: string;
    verified: boolean;
  };
}

interface HostSessionConfig {
  cookieNames: ReadonlySet<string>;
  identityAdapter: HostSessionIdentityAdapter;
  identityUrl: string;
  principalNamespace: string;
}

type HostSessionIdentityParser = (value: unknown) => HostSessionIdentity | null;

const HOST_SESSION_IDENTITY_ADAPTERS = {
  [HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1]: parseOidcUserInfoV1,
  [HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1]: parseAnacondaWhoamiV1,
} satisfies Record<HostSessionIdentityAdapter, HostSessionIdentityParser>;

const HOST_SESSION_IDENTITY_TIMEOUT_MS = 5_000;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function hostSessionHealth(env: HostSessionEnvironment): {
  status: "configured" | "partial" | "disabled";
} {
  const hasAnyConfig = Boolean(
    env.NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES?.trim() ||
    env.NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_ADAPTER?.trim() ||
    env.NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL?.trim() ||
    env.NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE?.trim(),
  );
  if (!hasAnyConfig) {
    return { status: "disabled" };
  }
  return { status: hostSessionConfigFromEnv(env) ? "configured" : "partial" };
}

export async function authenticateHostSessionRequest(
  request: Request,
  env: HostSessionEnvironment,
): Promise<AuthenticatedConnection | null> {
  const config = hostSessionConfigFromEnv(env);
  if (!config) {
    return null;
  }
  const cookie = selectedHostSessionCookieHeader(request, config.cookieNames);
  if (!cookie) {
    return null;
  }

  const response = await fetch(config.identityUrl, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
      Cookie: cookie,
    },
    redirect: "error",
    signal: AbortSignal.timeout(HOST_SESSION_IDENTITY_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  const identity = parseHostSessionIdentity(
    (await response.json().catch(() => null)) as unknown,
    config.identityAdapter,
  );
  if (!identity) {
    return null;
  }

  const principal = `${config.principalNamespace}:${encodePrincipalComponent(identity.subject)}`;
  try {
    validatePrincipal(principal);
  } catch {
    return null;
  }

  return {
    principal,
    operator: "browser:http",
    actorLabel: `${principal}/browser:http`,
    scope: "viewer",
    metadata: {
      // Host sessions and direct OIDC must converge on the same account realm.
      // The transport records how this request was authenticated.
      provider: "oidc",
      transport: "host-session-cookie",
      principalNamespace: config.principalNamespace,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
      ...(identity.email
        ? { email: identity.email.value, emailVerified: identity.email.verified }
        : {}),
    },
  };
}

export function parseHostSessionIdentity(
  value: unknown,
  adapter: HostSessionIdentityAdapter,
): HostSessionIdentity | null {
  return HOST_SESSION_IDENTITY_ADAPTERS[adapter](value);
}

function hostSessionConfigFromEnv(env: HostSessionEnvironment): HostSessionConfig | null {
  const cookieNames = new Set(
    env.NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES?.split(",")
      .map((value) => value.trim())
      .filter((value) => COOKIE_NAME_PATTERN.test(value)) ?? [],
  );
  const identityUrl = httpsUrl(env.NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL);
  const principalNamespace = normalizedPrincipalNamespace(
    env.NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE,
  );
  const identityAdapter = hostSessionIdentityAdapter(
    env.NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_ADAPTER,
  );
  if (!cookieNames.size || !identityUrl || !principalNamespace || !identityAdapter) {
    return null;
  }
  return { cookieNames, identityAdapter, identityUrl, principalNamespace };
}

function hostSessionIdentityAdapter(value: string | undefined): HostSessionIdentityAdapter | null {
  const normalized = value?.trim() || HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1;
  return normalized === HOST_SESSION_IDENTITY_ADAPTER_OIDC_USERINFO_V1 ||
    normalized === HOST_SESSION_IDENTITY_ADAPTER_ANACONDA_WHOAMI_V1
    ? normalized
    : null;
}

function httpsUrl(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function normalizedPrincipalNamespace(value: string | undefined): string | null {
  const namespace = value?.trim().replace(/:+$/, "");
  if (!namespace) {
    return null;
  }
  try {
    validatePrincipal(`${namespace}:subject`);
    return namespace;
  } catch {
    return null;
  }
}

function selectedHostSessionCookieHeader(
  request: Request,
  acceptedNames: ReadonlySet<string>,
): string | null {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName?.trim();
    if (name && acceptedNames.has(name)) {
      if (seen.has(name)) {
        return null;
      }
      seen.add(name);
      selected.push(`${name}=${rawValue.join("=").trim()}`);
    }
  }
  return selected.length ? selected.join("; ") : null;
}

function parseOidcUserInfoV1(value: unknown): HostSessionIdentity | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    family_name?: unknown;
    given_name?: unknown;
    name?: unknown;
    picture?: unknown;
    preferred_username?: unknown;
  };
  const subject = stringValue(body.sub);
  if (!subject) {
    return null;
  }
  const email = stringValue(body.email);
  const displayName =
    stringValue(body.name) ??
    displayNameFromParts(body.given_name, body.family_name) ??
    stringValue(body.preferred_username) ??
    email;
  const avatarUrl = stringValue(body.picture);
  return {
    subject,
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(email ? { email: { value: email, verified: body.email_verified === true } } : {}),
  };
}

function parseAnacondaWhoamiV1(value: unknown): HostSessionIdentity | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as {
    identity?: { id?: unknown; traits?: { email?: unknown } };
    passport?: {
      profile?: {
        email?: unknown;
        email_verified?: unknown;
        first_name?: unknown;
        is_confirmed?: unknown;
        last_name?: unknown;
        picture?: unknown;
        username?: unknown;
      };
      user_id?: unknown;
    };
  };
  const identitySubject = stringValue(body.identity?.id);
  const passportSubject = stringValue(body.passport?.user_id);
  if (identitySubject && passportSubject && identitySubject !== passportSubject) {
    return null;
  }
  const subject = identitySubject ?? passportSubject;
  if (!subject) {
    return null;
  }

  const profile = body.passport?.profile;
  const identityEmail = stringValue(body.identity?.traits?.email);
  const profileEmail = stringValue(profile?.email);
  if (identityEmail && profileEmail && identityEmail.toLowerCase() !== profileEmail.toLowerCase()) {
    return null;
  }
  const email = profileEmail ?? identityEmail;
  const emailVerified = Boolean(
    email && profileEmail && explicitlyVerified(profile?.is_confirmed, profile?.email_verified),
  );
  const displayName =
    displayNameFromParts(profile?.first_name, profile?.last_name) ??
    stringValue(profile?.username) ??
    email;
  const avatarUrl = stringValue(profile?.picture);
  return {
    subject,
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(email ? { email: { value: email, verified: emailVerified } } : {}),
  };
}

function explicitlyVerified(...claims: unknown[]): boolean {
  const booleans = claims.filter((claim): claim is boolean => typeof claim === "boolean");
  return booleans.length > 0 && booleans.every(Boolean);
}

function displayNameFromParts(firstName: unknown, lastName: unknown): string | undefined {
  const name = [stringValue(firstName), stringValue(lastName)].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
