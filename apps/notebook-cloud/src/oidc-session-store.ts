import type { D1Database, D1Value } from "./cloudflare-types.ts";
import type { CloudAppSession } from "./app-session.ts";

export interface ServerSessionEnvironment {
  DB?: D1Database;
  NOTEBOOK_CLOUD_OIDC_FLOW?: string;
  NOTEBOOK_CLOUD_APP_SESSION_SECRET?: string;
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN?: string;
  NOTEBOOK_CLOUD_OIDC_ISSUER?: string;
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID?: string;
}

export const SERVER_SESSION_COOKIE = "__Host-nteract_cloud_server_session";
export const SERVER_SESSION_IDLE_SECONDS = 6 * 60 * 60;
export const SERVER_SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

export const OIDC_SESSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oidc_login_transactions (
    state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL,
    context TEXT NOT NULL, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS oidc_login_expiry ON oidc_login_transactions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oidc_server_sessions (
    id TEXT PRIMARY KEY, context TEXT NOT NULL, session_json TEXT NOT NULL,
    sealed TEXT NOT NULL, access_expires_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS oidc_session_expiry ON oidc_server_sessions(idle_expires_at)`,
];

const schemas = new WeakMap<D1Database, Promise<void>>();

export function serverOidcEnabled(env: ServerSessionEnvironment): boolean {
  return env.NOTEBOOK_CLOUD_OIDC_FLOW === "server";
}

export async function oidcDatabase(env: ServerSessionEnvironment): Promise<D1Database> {
  const db = env.DB;
  if (!db) throw new Error("Server sign-in requires database storage");
  let ready = schemas.get(db);
  if (!ready) {
    ready = (async () => {
      for (const sql of OIDC_SESSION_SCHEMA) await db.prepare(sql).run();
    })().catch((error) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, ready);
  }
  await ready;
  return db;
}

export interface ServerSessionRow {
  id: string;
  context: string;
  session_json: string;
  sealed: string;
  access_expires_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  generation: number;
  lease: string | null;
  lease_until: number;
  retry_after: number;
}

export function serverSessionContext(env: ServerSessionEnvironment, origin: string): string {
  return JSON.stringify([
    env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim(),
    env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim(),
    origin,
  ]);
}

export async function loadServerSession(
  env: ServerSessionEnvironment,
  request: Request,
  now: number,
): Promise<ServerSessionRow | null> {
  const token = cookieValue(request, SERVER_SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = await oidcDatabase(env);
  const row = await db
    .prepare(`SELECT * FROM oidc_server_sessions WHERE id = ?
    AND idle_expires_at > ? AND absolute_expires_at > ?`)
    .bind(await serverSessionId(env, token), now, now)
    .first<ServerSessionRow>();
  const origin = env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
  return row?.context === serverSessionContext(env, new URL(origin).origin) ? row : null;
}

export async function readServerAppSession(
  env: ServerSessionEnvironment,
  request: Request,
  now: number,
): Promise<CloudAppSession | null> {
  const row = await loadServerSession(env, request, now);
  if (!row || row.access_expires_at <= now) return null;
  const session: CloudAppSession = JSON.parse(row.session_json);
  return session.expiresAt > now ? session : null;
}

export async function revokeServerSession(
  env: ServerSessionEnvironment,
  request: Request,
): Promise<void> {
  const token = cookieValue(request, SERVER_SESSION_COOKIE);
  if (!token) return;
  const db = await oidcDatabase(env);
  await db
    .prepare("DELETE FROM oidc_server_sessions WHERE id = ?")
    .bind(await serverSessionId(env, token))
    .run();
}

export function serverSessionCookie(token: string, maxAge = SERVER_SESSION_IDLE_SECONDS): string {
  return `${SERVER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function cookieValue(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}

export function randomSecret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function secretHash(value: string): Promise<string> {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

export async function serverSessionId(
  env: ServerSessionEnvironment,
  token: string,
): Promise<string> {
  const secret = env.NOTEBOOK_CLOUD_APP_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Server sign-in requires a session secret");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`nteract/server-session-id/v1:${token}`),
      ),
    ),
  );
}

async function encryptionKey(env: ServerSessionEnvironment): Promise<CryptoKey> {
  const secret = env.NOTEBOOK_CLOUD_APP_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Server sign-in requires a session secret");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("nteract/server-oidc/v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealServerSecret(
  env: ServerSessionEnvironment,
  value: unknown,
  binding: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(binding) },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(bytes))}`;
}

export async function openServerSecret<T>(
  env: ServerSessionEnvironment,
  value: string,
  binding: string,
): Promise<T> {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new Error("Invalid encrypted session");
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv), additionalData: new TextEncoder().encode(binding) },
    await encryptionKey(env),
    decode(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
}

export async function conditionalSessionUpdate(
  db: D1Database,
  row: ServerSessionRow,
  lease: string,
  set: string,
  values: D1Value[],
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE oidc_server_sessions SET ${set} WHERE id = ? AND generation = ? AND lease = ?`)
    .bind(...values, row.id, row.generation, lease)
    .run();
  return result.meta.changes === 1;
}
