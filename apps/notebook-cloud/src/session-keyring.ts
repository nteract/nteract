/**
 * The keys behind app-session HMACs, sealed sign-in state and list cursors.
 *
 * `NOTEBOOK_CLOUD_APP_SESSION_KEYS` holds a keyring as JSON:
 *
 *     {"active":"k2","keys":{"k1":"<secret>","k2":"<secret>"},
 *      "activated_at":{"k2":"2026-11-06T00:00:00Z"}}
 *
 * New values are signed or sealed with `active`; values from any listed key
 * still verify or open. `activated_at` is operator bookkeeping for the
 * rotation overlap and has no effect here. On Cloudflare the JSON is a Worker
 * secret; on celld the installer writes it into vars.
 *
 * Without the variable, `NOTEBOOK_CLOUD_APP_SESSION_SECRET` is the only key,
 * `k1`, exactly as configured. A deployment that never sets the keyring keeps
 * every value it has issued. A malformed keyring throws
 * `SessionKeyringError` on every use rather than falling back to the single
 * secret, so a bad rotation fails closed instead of quietly signing with an
 * old key.
 *
 * scripts/deployment/session-keys.mjs in Pages validates the same shape for
 * the installer, which runs without TypeScript. Keep the two in step; a Pages
 * test runs both over one table of cases.
 */

export interface SessionKeyringEnvironment {
  NOTEBOOK_CLOUD_APP_SESSION_SECRET?: string;
  NOTEBOOK_CLOUD_APP_SESSION_KEYS?: string;
}

export interface SessionKey {
  readonly kid: string;
  readonly secret: string;
}

export interface SessionKeyring {
  /** The key new values are signed and sealed with. */
  readonly active: SessionKey;
  /** Every key, `active` first, then the others in configured order. */
  readonly keys: readonly SessionKey[];
  /**
   * `secret` when synthesized from `NOTEBOOK_CLOUD_APP_SESSION_SECRET`. Seals
   * then keep the bare `iv.ct` form, so a build without the keyring can still
   * open them. `keyring` seals carry their kid.
   */
  readonly source: "secret" | "keyring";
}

/** The kid of the single-secret configuration and of sealed values without one. */
export const LEGACY_SESSION_KID = "k1";
export const SESSION_KEY_MIN_BYTES = 32;
/** Every lookup tries each key, so the keyring stays small. */
export const SESSION_KEYRING_MAX_KEYS = 4;
/** A kid prefixes sealed values with a `.`, so it never contains one. */
export const SESSION_KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class SessionKeyringError extends Error {
  constructor(reason: string) {
    super(`NOTEBOOK_CLOUD_APP_SESSION_KEYS is invalid: ${reason}`);
    this.name = "SessionKeyringError";
  }
}

const parsed = new Map<string, SessionKeyring | SessionKeyringError>();

/**
 * The configured keyring, or null when neither variable configures a key.
 * Throws `SessionKeyringError` when the keyring variable is present but
 * malformed. The error names the problem, never a secret.
 */
export function sessionKeyring(env: SessionKeyringEnvironment | undefined): SessionKeyring | null {
  const raw = env?.NOTEBOOK_CLOUD_APP_SESSION_KEYS;
  if (raw === undefined || raw === "") {
    const secret = env?.NOTEBOOK_CLOUD_APP_SESSION_SECRET;
    if (typeof secret !== "string" || secret.length < SESSION_KEY_MIN_BYTES) return null;
    const key = { kid: LEGACY_SESSION_KID, secret };
    return { active: key, keys: [key], source: "secret" };
  }
  let result = parsed.get(raw);
  if (!result) {
    try {
      result = parseSessionKeyring(raw);
    } catch (error) {
      result =
        error instanceof SessionKeyringError ? error : new SessionKeyringError("unreadable JSON");
    }
    // A deployment has one or two values over its life; keep the cache tiny.
    if (parsed.size >= 8) parsed.clear();
    parsed.set(raw, result);
  }
  if (result instanceof SessionKeyringError) throw result;
  return result;
}

/** Throws `SessionKeyringError` when the keyring variable is malformed. */
export function assertSessionKeyring(env: SessionKeyringEnvironment | undefined): void {
  sessionKeyring(env);
}

export function parseSessionKeyring(raw: string): SessionKeyring {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionKeyringError("not JSON");
  }
  if (!isRecord(value)) throw new SessionKeyringError("expected a JSON object");
  for (const field of Object.keys(value))
    if (!["active", "keys", "activated_at"].includes(field))
      throw new SessionKeyringError(`unknown field ${JSON.stringify(field.slice(0, 40))}`);
  const { active, keys, activated_at: activatedAt } = value;
  if (!isRecord(keys)) throw new SessionKeyringError("keys must be an object of kid to secret");
  const kids = Object.keys(keys);
  if (kids.length < 1 || kids.length > SESSION_KEYRING_MAX_KEYS)
    throw new SessionKeyringError(`keys must hold 1 to ${SESSION_KEYRING_MAX_KEYS} keys`);
  const entries: SessionKey[] = [];
  for (const kid of kids) {
    if (!SESSION_KID_PATTERN.test(kid))
      throw new SessionKeyringError("a kid must be 1-32 characters of A-Z, a-z, 0-9, _ or -");
    const secret = keys[kid];
    if (typeof secret !== "string") throw new SessionKeyringError(`key ${kid} is not a string`);
    if (secret !== secret.trim())
      throw new SessionKeyringError(`key ${kid} has surrounding whitespace`);
    if (new TextEncoder().encode(secret).byteLength < SESSION_KEY_MIN_BYTES)
      throw new SessionKeyringError(`key ${kid} is shorter than ${SESSION_KEY_MIN_BYTES} bytes`);
    entries.push({ kid, secret });
  }
  if (new Set(entries.map(({ secret }) => secret)).size !== entries.length)
    throw new SessionKeyringError("two kids share a secret");
  if (typeof active !== "string" || !Object.hasOwn(keys, active))
    throw new SessionKeyringError("active must name a kid in keys");
  if (activatedAt !== undefined) {
    if (!isRecord(activatedAt))
      throw new SessionKeyringError("activated_at must be an object of kid to time");
    for (const [kid, at] of Object.entries(activatedAt))
      if (!Object.hasOwn(keys, kid) || typeof at !== "string" || Number.isNaN(Date.parse(at)))
        throw new SessionKeyringError("activated_at must map kids in keys to ISO times");
  }
  const current = entries.find(({ kid }) => kid === active)!;
  const ordered: SessionKey[] = [current, ...entries.filter((key) => key !== current)];
  return Object.freeze({
    active: current,
    keys: Object.freeze(ordered.map((key) => Object.freeze(key))),
    source: "keyring",
  });
}

/** Seal format: `kid.iv.ct`. A bare `iv.ct` is the legacy `k1` form. */
export function splitSealed(value: string): { kid: string; rest: string[] } {
  const parts = value.split(".");
  if (parts.length === 2) return { kid: LEGACY_SESSION_KID, rest: parts };
  const [kid, ...rest] = parts;
  return { kid: kid ?? "", rest };
}

export function sessionKeyByKid(keyring: SessionKeyring, kid: string): SessionKey | undefined {
  return keyring.keys.find((key) => key.kid === kid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
