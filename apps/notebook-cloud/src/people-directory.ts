import type { Env } from "./cloudflare-types.ts";
import type { AuthenticatedConnection } from "./identity.ts";
import { getPrincipalProfile } from "./sharing-storage.ts";
import { normalizeInviteEmail } from "./sharing.ts";

/** Administrator-supplied roster data, independent of login/account records. */
export interface DirectoryPerson {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PeopleDirectory {
  allowedDomains: ReadonlySet<string>;
  people: readonly DirectoryPerson[];
}

export interface PeopleDirectoryResult {
  directoryEnabled: boolean;
  people: Array<{
    id: string;
    displayName: string;
    avatarUrl: string | null;
    source: "directory";
  }>;
}

const MAX_ROSTER_BYTES = 128 * 1024;
const MAX_ROSTER_PEOPLE = 1000;
const MAX_RESULTS = 10;
const OPAQUE_PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class PeopleDirectoryConfigurationError extends Error {
  constructor() {
    super("people directory configuration is invalid");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function domain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 253 && EXACT_DOMAIN.test(normalized) ? normalized : null;
}

function email(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  try {
    const normalized = normalizeInviteEmail(value);
    const [local, host] = normalized.split("@");
    return local.length <= 64 && domain(host) === host ? normalized : null;
  } catch {
    return null;
  }
}

function avatar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2048)
    throw new PeopleDirectoryConfigurationError();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new PeopleDirectoryConfigurationError();
  }
}

/** Missing configuration disables discovery. Invalid configuration fails closed. */
export function parsePeopleDirectory(raw: string | undefined): PeopleDirectory | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (new TextEncoder().encode(raw).length > MAX_ROSTER_BYTES) {
    throw new PeopleDirectoryConfigurationError();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PeopleDirectoryConfigurationError();
  }
  if (
    !record(value) ||
    !Array.isArray(value.allowedDomains) ||
    value.allowedDomains.length === 0 ||
    value.allowedDomains.length > 32 ||
    !Array.isArray(value.people) ||
    value.people.length > MAX_ROSTER_PEOPLE
  ) {
    throw new PeopleDirectoryConfigurationError();
  }
  const allowedDomains = new Set<string>();
  for (const candidate of value.allowedDomains) {
    const normalized = domain(candidate);
    if (!normalized) throw new PeopleDirectoryConfigurationError();
    allowedDomains.add(normalized);
  }
  const ids = new Set<string>();
  const emails = new Set<string>();
  const people: DirectoryPerson[] = [];
  for (const candidate of value.people) {
    if (
      !record(candidate) ||
      typeof candidate.id !== "string" ||
      !OPAQUE_PERSON_ID.test(candidate.id) ||
      ids.has(candidate.id.toLowerCase()) ||
      typeof candidate.displayName !== "string" ||
      !candidate.displayName.trim() ||
      candidate.displayName.trim().length > 128
    ) {
      throw new PeopleDirectoryConfigurationError();
    }
    const normalizedEmail = email(candidate.email);
    if (
      !normalizedEmail ||
      !allowedDomains.has(normalizedEmail.split("@")[1]) ||
      emails.has(normalizedEmail)
    ) {
      throw new PeopleDirectoryConfigurationError();
    }
    ids.add(candidate.id.toLowerCase());
    emails.add(normalizedEmail);
    people.push({
      id: candidate.id.toLowerCase(),
      email: normalizedEmail,
      displayName: candidate.displayName.trim(),
      avatarUrl: avatar(candidate.avatarUrl),
    });
  }
  return { allowedDomains, people };
}

/** Only provider-verified claims or the current server-stored session profile qualify. */
export async function directoryCallerEmail(
  env: Env,
  identity: AuthenticatedConnection,
): Promise<string | null> {
  if (identity.metadata.provider === "oidc") {
    return identity.metadata.emailVerified === true ? email(identity.metadata.email) : null;
  }
  if (identity.metadata.provider === "anaconda-api-key") {
    // The existing whoami contract also backs verified-email invite resolution.
    return email(identity.metadata.email);
  }
  if (identity.metadata.provider === "app-session") {
    const profile = await getPrincipalProfile(env, identity.principal);
    return profile?.provider === "oidc" && profile.email_verified === 1
      ? email(profile.email_normalized)
      : null;
  }
  return null;
}

function eligiblePeople(directory: PeopleDirectory | null, callerEmail: string | null) {
  const normalizedEmail = email(callerEmail);
  const callerDomain = normalizedEmail?.split("@")[1];
  if (!directory || !callerDomain || !directory.allowedDomains.has(callerDomain)) return null;
  return directory.people.filter(
    (person) => person.email !== normalizedEmail && person.email.split("@")[1] === callerDomain,
  );
}

export function searchPeopleDirectory(
  directory: PeopleDirectory | null,
  callerEmail: string | null,
  query: string,
): PeopleDirectoryResult {
  const candidates = eligiblePeople(directory, callerEmail);
  if (!candidates) return { directoryEnabled: false, people: [] };
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 80) {
    return { directoryEnabled: true, people: [] };
  }
  const people = candidates
    .filter(
      (person) =>
        person.displayName
          .toLowerCase()
          .split(/\s+/)
          .some((part) => part.startsWith(normalized)) ||
        person.displayName.toLowerCase().startsWith(normalized) ||
        person.email.startsWith(normalized),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .slice(0, MAX_RESULTS)
    .map(({ id, displayName, avatarUrl }) => ({
      id,
      displayName,
      avatarUrl,
      source: "directory" as const,
    }));
  return { directoryEnabled: true, people };
}

/** Resolve selection with the current roster and caller policy, never a client-supplied email. */
export function resolveDirectoryPerson(
  directory: PeopleDirectory | null,
  callerEmail: string | null,
  personId: string,
): DirectoryPerson | null {
  return eligiblePeople(directory, callerEmail)?.find((person) => person.id === personId) ?? null;
}
