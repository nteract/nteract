// Session keyring files for the installer and for key rotation. Plain Node,
// no imports beyond builtins: the installer stages it next to install.mjs, and
// `deploy.mjs rotate-key` streams it to the host over SSH.
//
// The keyring is the JSON `NOTEBOOK_CLOUD_APP_SESSION_KEYS` holds (see
// apps/notebook-cloud/src/session-keyring.ts, whose validation this mirrors):
//
//   {"active":"k2","keys":{"k1":"…","k2":"…"},"activated_at":{"k2":"<ISO>"}}
//
// Rotation lifecycle, one pure transition per event:
//
//   single secret ──rotate──▶ keyring(active kN+1, older keys verify only)
//   keyring       ──rotate──▶ keyring(new active, ≤ 4 keys)
//   keyring       ──retire──▶ keyring(older keys removed), only once the
//                             active key has been active for the overlap
//
// The overlap is the server session's absolute lifetime: a session row keeps
// the id its key derived until it expires, so retiring earlier signs people
// out. Every result describes kids and times, never secrets.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SESSION_KEYS_VAR = "NOTEBOOK_CLOUD_APP_SESSION_KEYS";
export const SESSION_SECRET_VAR = "NOTEBOOK_CLOUD_APP_SESSION_SECRET";
export const LEGACY_KID = "k1";
export const MAX_KEYS = 4;
export const MIN_SECRET_BYTES = 32;
/** `SERVER_SESSION_ABSOLUTE_SECONDS` in apps/notebook-cloud/src/oidc-session-store.ts. */
export const OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const KID = /^[A-Za-z0-9_-]{1,32}$/;

const invalid = (reason) => new Error("Session keyring is invalid: " + reason);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates keyring JSON text and returns `{ active, keys, activated_at }`. */
export function parseKeyring(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("not JSON");
  }
  return validateKeyring(value);
}

export function validateKeyring(value) {
  if (!isRecord(value)) throw invalid("expected a JSON object");
  for (const field of Object.keys(value))
    if (!["active", "keys", "activated_at"].includes(field))
      throw invalid("unknown field " + JSON.stringify(field.slice(0, 40)));
  const { active, keys, activated_at: activatedAt = {} } = value;
  if (!isRecord(keys)) throw invalid("keys must be an object of kid to secret");
  const kids = Object.keys(keys);
  if (kids.length < 1 || kids.length > MAX_KEYS)
    throw invalid(`keys must hold 1 to ${MAX_KEYS} keys`);
  for (const kid of kids) {
    if (!KID.test(kid)) throw invalid("a kid must be 1-32 characters of A-Z, a-z, 0-9, _ or -");
    const secret = keys[kid];
    if (typeof secret !== "string") throw invalid(`key ${kid} is not a string`);
    if (secret !== secret.trim()) throw invalid(`key ${kid} has surrounding whitespace`);
    if (Buffer.byteLength(secret) < MIN_SECRET_BYTES)
      throw invalid(`key ${kid} is shorter than ${MIN_SECRET_BYTES} bytes`);
  }
  if (new Set(Object.values(keys)).size !== kids.length) throw invalid("two kids share a secret");
  if (typeof active !== "string" || !Object.hasOwn(keys, active))
    throw invalid("active must name a kid in keys");
  if (!isRecord(activatedAt)) throw invalid("activated_at must be an object of kid to time");
  for (const [kid, at] of Object.entries(activatedAt))
    if (!Object.hasOwn(keys, kid) || typeof at !== "string" || Number.isNaN(Date.parse(at)))
      throw invalid("activated_at must map kids in keys to ISO times");
  return {
    active,
    keys: { ...keys },
    ...(Object.keys(activatedAt).length && { activated_at: { ...activatedAt } }),
  };
}

/**
 * The Worker vars the installer writes. With a keyring file, the keyring
 * alone; without one, the single secret exactly as before, which the Worker
 * reads as `k1`.
 */
export function sessionVars({ keyring, secret }) {
  if (keyring !== undefined) return { [SESSION_KEYS_VAR]: JSON.stringify(parseKeyring(keyring)) };
  return { [SESSION_SECRET_VAR]: secret.trim() };
}

/** The keyring a single secret stands for, so rotation can start from it. */
export function seedKeyring(secret) {
  return validateKeyring({ active: LEGACY_KID, keys: { [LEGACY_KID]: secret.trim() } });
}

function nextKid(keyring) {
  const numbers = Object.keys(keyring.keys)
    .map((kid) => /^k(\d{1,9})$/.exec(kid)?.[1])
    .filter(Boolean)
    .map(Number);
  let next = Math.max(0, ...numbers) + 1;
  while (Object.hasOwn(keyring.keys, "k" + next)) next++;
  return "k" + next;
}

/** A keyring with every secret left out, for plans and receipts. */
export function describeKeyring(keyring) {
  const activatedAt = keyring.activated_at?.[keyring.active];
  return {
    active: keyring.active,
    kids: Object.keys(keyring.keys),
    ...(keyring.activated_at && { activated_at: keyring.activated_at }),
    ...(activatedAt && {
      retire_after: new Date(Date.parse(activatedAt) + OVERLAP_MS).toISOString(),
    }),
  };
}

/**
 * Rotate: add a key and make it active. `from` fences the transition to the
 * active kid the operator planned against, so a retried apply after an
 * uncertain result can't add a second key.
 */
export function rotateKeyring(keyring, { secret, now, from }) {
  if (from !== undefined && from !== keyring.active)
    throw new Error(`The active key is ${keyring.active}, not ${from}; plan again before applying`);
  if (Object.keys(keyring.keys).length >= MAX_KEYS)
    throw new Error(`The keyring already holds ${MAX_KEYS} keys; retire one first`);
  const kid = nextKid(keyring);
  const next = validateKeyring({
    active: kid,
    keys: { ...keyring.keys, [kid]: secret },
    activated_at: { ...keyring.activated_at, [kid]: new Date(now).toISOString() },
  });
  return { keyring: next, change: { rotated: { from: keyring.active, to: kid } } };
}

/**
 * Retire: remove `kid`, or every key but the active one. Refused until the
 * active key has been active for the overlap, measured from its recorded
 * activation; `force` skips that wait and signs out sessions under the
 * retired keys.
 */
export function retireKeyring(keyring, { kid, now, force = false, from }) {
  if (from !== undefined && from !== keyring.active)
    throw new Error(`The active key is ${keyring.active}, not ${from}; plan again before applying`);
  if (kid !== undefined && !Object.hasOwn(keyring.keys, kid))
    throw new Error(`No key ${kid} in the keyring`);
  if (kid === keyring.active) throw new Error("Rotate to a new key before retiring the active one");
  const retiring =
    kid !== undefined ? [kid] : Object.keys(keyring.keys).filter((k) => k !== keyring.active);
  if (!retiring.length) return { keyring, change: { retired: [] } };
  const activatedAt = keyring.activated_at?.[keyring.active];
  if (!force) {
    if (!activatedAt)
      throw new Error(
        `Key ${keyring.active} has no recorded activation; wait out the overlap and pass --force`,
      );
    const due = Date.parse(activatedAt) + OVERLAP_MS;
    if (now < due)
      throw new Error(
        `Sessions under ${retiring.join(", ")} may last until ${new Date(due).toISOString()}; retire after then`,
      );
  }
  const keys = Object.fromEntries(
    Object.entries(keyring.keys).filter(([k]) => !retiring.includes(k)),
  );
  const times = Object.fromEntries(
    Object.entries(keyring.activated_at ?? {}).filter(([k]) => !retiring.includes(k)),
  );
  return {
    keyring: validateKeyring({ active: keyring.active, keys, activated_at: times }),
    change: { retired: retiring },
  };
}

/**
 * Arguments for this helper on a celld host, from `deploy.mjs rotate-key` or
 * `retire-key` options. The files are the service's own: the keyring the
 * installer reads and the single secret it seeds `k1` from.
 */
export function hostKeyCommand(mode, options, service) {
  const verb = { "rotate-key": "rotate", "retire-key": "retire" }[mode];
  if (!verb || !/^[a-z0-9-]{1,64}$/.test(service ?? "")) throw new Error(usage);
  const passed = [];
  for (let index = 0; index < options.length; index++) {
    const flag = options[index];
    if (flag === "--apply" || (flag === "--force" && verb === "retire")) passed.push(flag);
    else if (
      (flag === "--from" || (flag === "--kid" && verb === "retire")) &&
      KID.test(options[index + 1] ?? "")
    )
      passed.push(flag, options[++index]);
    else throw new Error(usage);
  }
  if (passed.includes("--apply") && !passed.includes("--from"))
    throw new Error("--apply needs --from ACTIVE_KID, the active kid the plan showed");
  return [
    verb,
    "--file",
    `/etc/${service}/session-keys.json`,
    "--secret-file",
    `/etc/${service}/session-secret`,
    ...passed,
  ];
}

const usage =
  "Usage: session-keys.mjs show|rotate|retire --file KEYS_JSON [--secret-file SECRET] [--kid KID] [--from ACTIVE_KID] [--force] [--apply]";

function options(argv) {
  const [verb, ...rest] = argv;
  const parsed = { verb };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--apply" || flag === "--force") parsed[flag.slice(2)] = true;
    else if (["--file", "--secret-file", "--kid", "--from"].includes(flag) && rest[index + 1])
      parsed[flag.slice(2)] = rest[++index];
    else throw new Error(usage);
  }
  if (!["show", "rotate", "retire"].includes(verb) || !parsed.file) throw new Error(usage);
  if (parsed.verb !== "retire" && (parsed.kid || parsed.force)) throw new Error(usage);
  if (parsed.verb === "show" && (parsed.apply || parsed.from)) throw new Error(usage);
  if (parsed.apply && !parsed.from)
    throw new Error("--apply needs --from ACTIVE_KID, the active kid the plan showed");
  return parsed;
}

/**
 * Runs one verb against a keyring file. Without `--apply` it reports the
 * plan and writes nothing. A missing keyring file reads as `k1` from
 * `--secret-file`. Writes go to a 0600 temporary file renamed into place.
 */
export function main(
  argv,
  {
    fs = { existsSync, readFileSync, renameSync, writeFileSync },
    now = Date.now(),
    random = () => randomBytes(48).toString("base64url"),
  } = {},
) {
  const args = options(argv);
  const present = fs.existsSync(args.file);
  let current;
  if (present) current = parseKeyring(fs.readFileSync(args.file, "utf8"));
  else if (args["secret-file"] && fs.existsSync(args["secret-file"]))
    current = seedKeyring(fs.readFileSync(args["secret-file"], "utf8"));
  else throw new Error("No keyring file and no single secret to start from");
  const before = { ...describeKeyring(current), source: present ? "keyring" : "single secret" };
  if (args.verb === "show") return { keyring: before };
  const { keyring, change } =
    args.verb === "rotate"
      ? rotateKeyring(current, { secret: random(), now, from: args.from })
      : retireKeyring(current, { kid: args.kid, now, force: args.force, from: args.from });
  const result = { before, after: describeKeyring(keyring), ...change, applied: false };
  if (!args.apply || keyring === current) return result;
  const temporary = args.file + ".next";
  fs.writeFileSync(temporary, JSON.stringify(keyring, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, args.file);
  return { ...result, applied: true };
}

const invokedDirectly =
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invokedDirectly) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
