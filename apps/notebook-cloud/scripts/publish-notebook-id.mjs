import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;

export function notebookIdFromEnvOrGenerated(env = process.env) {
  return env.NOTEBOOK_CLOUD_NOTEBOOK_ID ?? createUlid();
}

export function runtimeStateDocIdFromEnvOrDefault(notebookId, env = process.env) {
  return env.NOTEBOOK_CLOUD_RUNTIME_STATE_DOC_ID ?? `runtime:${notebookId}`;
}

export function vanityNameFromEnvOrNotebookName(name, env = process.env) {
  return env.NOTEBOOK_CLOUD_VANITY_NAME ?? slugifyVanityName(notebookNameStem(name));
}

export function canonicalViewerUrl(baseUrl, notebookId, vanityName) {
  return new URL(`/n/${encodeURIComponent(notebookId)}/${encodeURIComponent(vanityName)}`, baseUrl)
    .href;
}

export function createUlid(now = Date.now(), random = randomBytes(10)) {
  if (!Number.isInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError(`ULID timestamp must fit in 48 bits, got ${now}`);
  }
  if (!(random instanceof Uint8Array) || random.byteLength !== 10) {
    throw new RangeError("ULID random bytes must be a 10-byte Uint8Array");
  }

  return `${encodeTime(now)}${encodeRandom(random)}`;
}

export function isCanonicalUlid(value) {
  return (
    typeof value === "string" &&
    value.length === ULID_LENGTH &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
  );
}

function encodeTime(now) {
  let value = now;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD_BASE32[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return encoded;
}

function encodeRandom(bytes) {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let encoded = "";
  for (let index = 0; index < 16; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function slugifyVanityName(title) {
  return (
    String(title ?? "notebook")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "notebook"
  );
}

function notebookNameStem(name) {
  const basename =
    String(name ?? "notebook")
      .split(/[\\/]/)
      .pop() ?? "notebook";
  return basename.replace(/\.ipynb$/i, "");
}
