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
//                             Worker has used the active key for the overlap
//
// The overlap counts from when the Worker starts signing with the active key,
// not from the rotation. On celld the installer records that moment in
// `session-keys-active.json` (`installedRecord`); on Cloudflare it is the
// `wrangler secret put`, which `activated_at` stands for. The overlap is the
// longest a value signed with a retiring key stays in use: 7 days for server
// sessions, 30 days where OAuth grants keep email proofs. Every result
// describes kids and times, never secrets.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

export const SESSION_KEYS_VAR = "NOTEBOOK_CLOUD_APP_SESSION_KEYS";
export const SESSION_SECRET_VAR = "NOTEBOOK_CLOUD_APP_SESSION_SECRET";
export const LEGACY_KID = "k1";
export const MAX_KEYS = 4;
export const MIN_SECRET_BYTES = 32;
const DAY_SECONDS = 24 * 60 * 60;
/** `SERVER_SESSION_ABSOLUTE_SECONDS` in apps/notebook-cloud/src/oidc-session-store.ts. */
export const SESSION_OVERLAP_DAYS = 7;
/** `OAUTH_REFRESH_SECONDS` in shared/oauth-grant.mjs, in days. A test keeps
 * them equal: this file is streamed to hosts alone and can't import it. */
export const OAUTH_OVERLAP_DAYS = 30;
/** Where the overlap isn't given, assume OAuth grants hold proofs. */
export const DEFAULT_OVERLAP_DAYS = OAUTH_OVERLAP_DAYS;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
/** The suffix rotation moves a seeded single secret to. */
export const MOVED_SECRET_SUFFIX = ".k1";

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
      throw invalid("only active, keys and activated_at are allowed");
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
 * The Worker vars the installer writes: the keyring alone when there is one,
 * otherwise the single secret exactly as before, which the Worker reads as
 * `k1`. `secret` is read only without a keyring.
 */
export function sessionVars({ keyring, secret }) {
  if (keyring !== undefined) return { [SESSION_KEYS_VAR]: JSON.stringify(parseKeyring(keyring)) };
  return { [SESSION_SECRET_VAR]: secret().trim() };
}

/**
 * `config` with its session vars replaced by `vars`. The installer applies
 * this to every older release directory on a keyring install, so a
 * `celld deploy` rollback to one runs the current keyring, and a retired key
 * neither comes back nor stays on disk.
 */
export function withSessionVars(config, vars) {
  const { [SESSION_KEYS_VAR]: _keys, [SESSION_SECRET_VAR]: _secret, ...rest } = config.vars ?? {};
  return { ...config, vars: { ...rest, ...vars } };
}

/** The keyring a single secret stands for, so rotation can start from it. */
export function seedKeyring(secret) {
  // The Worker reads the secret var as written; a seed that differs from it
  // by whitespace would be a different key.
  if (secret !== secret.trim())
    throw new Error("The single secret has surrounding whitespace; fix the file before rotating");
  return validateKeyring({ active: LEGACY_KID, keys: { [LEGACY_KID]: secret } });
}

/**
 * The installer's record of when the Worker began signing with a key:
 * `{ active, activated_at, deployment_version }`. It carries the earlier
 * record forward only when the deployment running before this install is the
 * one that record names, with the same active key. Anything else (a first
 * keyring, a new active key, a rollback or a failed install in between)
 * starts the overlap now. Null without a keyring.
 */
export function installedRecord({ previous, active, liveBefore, deployedVersion, now }) {
  if (active === undefined) return null;
  if (
    previous?.active === active &&
    typeof previous.activated_at === "string" &&
    !Number.isNaN(Date.parse(previous.activated_at)) &&
    previous.deployment_version === liveBefore
  )
    return { ...previous, deployment_version: deployedVersion };
  return {
    active,
    activated_at: new Date(now).toISOString(),
    deployment_version: deployedVersion,
  };
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
  return {
    active: keyring.active,
    kids: Object.keys(keyring.keys),
    ...(keyring.activated_at && { activated_at: keyring.activated_at }),
  };
}

const fenced = (keyring, from) => {
  if (from !== undefined && from !== keyring.active)
    throw new Error(`The active key is ${keyring.active}, not ${from}; plan again before applying`);
};

/**
 * Rotate: add a key and make it active. `from` fences the transition to the
 * active kid the operator planned against, so a retried apply after an
 * uncertain result can't add a second key.
 */
export function rotateKeyring(keyring, { secret, now, from }) {
  fenced(keyring, from);
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

/** The kids `retire` would remove: `kid`, or every key but the active one. */
export function retiring(keyring, kid) {
  if (kid !== undefined && !Object.hasOwn(keyring.keys, kid))
    throw new Error(`No key ${kid} in the keyring`);
  if (kid === keyring.active) throw new Error("Rotate to a new key before retiring the active one");
  return kid !== undefined ? [kid] : Object.keys(keyring.keys).filter((k) => k !== keyring.active);
}

/**
 * Retire: remove older keys once the Worker has signed with the active key
 * for `overlapDays` since `activatedAt`. `force` skips that wait and signs
 * out whatever the retired keys still protect.
 */
export function retireKeyring(
  keyring,
  { kid, now, force = false, from, activatedAt, overlapDays = DEFAULT_OVERLAP_DAYS },
) {
  fenced(keyring, from);
  const removed = retiring(keyring, kid);
  if (!removed.length) return { keyring, change: { retired: [], nothing_to_do: true } };
  if (!force) {
    if (!activatedAt)
      throw new Error(
        `No recorded time when the Worker began signing with ${keyring.active}; wait out the overlap and pass --force`,
      );
    const due = Date.parse(activatedAt) + overlapDays * DAY_SECONDS * 1000;
    if (now < due)
      throw new Error(
        `Values signed with ${removed.join(", ")} may stay in use until ${new Date(due).toISOString()}; retire after then`,
      );
  }
  const keys = Object.fromEntries(
    Object.entries(keyring.keys).filter(([k]) => !removed.includes(k)),
  );
  const times = Object.fromEntries(
    Object.entries(keyring.activated_at ?? {}).filter(([k]) => !removed.includes(k)),
  );
  return {
    keyring: validateKeyring({ active: keyring.active, keys, activated_at: times }),
    change: { retired: removed },
  };
}

/**
 * Arguments for this helper on a celld host, from `deploy.mjs rotate-key` or
 * `retire-key` options. The files are the service's own: the keyring and the
 * installer's activation record, and the single secret rotation seeds `k1`
 * from and moves aside. Retire asks the local node which deployment runs.
 */
export function hostKeyCommand(mode, options, deployment, { overlapDays } = {}) {
  const verb = { "rotate-key": "rotate", "retire-key": "retire" }[mode];
  const service = deployment?.service;
  if (
    !verb ||
    !/^[a-z0-9-]{1,64}$/.test(service ?? "") ||
    !/^127\.0\.0\.1:\d{1,5}$/.test(deployment?.internalListen ?? "")
  )
    throw new Error(usage);
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
  const dir = `/etc/${service}`;
  return [
    verb,
    "--file",
    `${dir}/session-keys.json`,
    "--secret-file",
    `${dir}/session-secret`,
    ...(verb === "rotate"
      ? ["--move-secret"]
      : [
          "--installed",
          `${dir}/session-keys-active.json`,
          "--state-url",
          `http://${deployment.internalListen}/state`,
          "--overlap-days",
          String(overlapDays ?? DEFAULT_OVERLAP_DAYS),
        ]),
    ...passed,
  ];
}

const usage =
  "Usage: session-keys.mjs show|rotate|retire --file KEYS_JSON [--secret-file SECRET] [--move-secret] [--installed RECORD --state-url URL] [--overlap-days N] [--kid KID] [--from ACTIVE_KID] [--force] [--apply]";

function options(argv) {
  const [verb, ...rest] = argv;
  const parsed = { verb };
  const values = [
    "--file",
    "--secret-file",
    "--kid",
    "--from",
    "--installed",
    "--state-url",
    "--overlap-days",
  ];
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (["--apply", "--force", "--move-secret"].includes(flag)) parsed[flag.slice(2)] = true;
    else if (values.includes(flag) && rest[index + 1]) parsed[flag.slice(2)] = rest[++index];
    else throw new Error(usage);
  }
  if (!["show", "rotate", "retire"].includes(verb) || !parsed.file) throw new Error(usage);
  if (
    verb !== "retire" &&
    (parsed.kid || parsed.force || parsed.installed || parsed["overlap-days"])
  )
    throw new Error(usage);
  if (verb !== "rotate" && parsed["move-secret"]) throw new Error(usage);
  if (verb === "show" && (parsed.apply || parsed.from)) throw new Error(usage);
  if (Boolean(parsed.installed) !== Boolean(parsed["state-url"])) throw new Error(usage);
  if (parsed["overlap-days"] !== undefined) {
    const days = Number(parsed["overlap-days"]);
    if (!Number.isSafeInteger(days) || days < SESSION_OVERLAP_DAYS)
      throw new Error(`--overlap-days must be a whole number of at least ${SESSION_OVERLAP_DAYS}`);
    parsed["overlap-days"] = days;
  }
  if (parsed.apply && !parsed.from)
    throw new Error("--apply needs --from ACTIVE_KID, the active kid the plan showed");
  return parsed;
}

/** Writes `text` to a 0600 temporary file, syncs it, then renames it into place. */
function writeAtomic(fs, file, text) {
  const temporary = file + ".next";
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    // An interrupted run may have left the temporary file with other modes.
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function liveDeploymentVersion(url) {
  const state = execFileSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--max-time", "5", url],
    {
      encoding: "utf8",
    },
  );
  return JSON.parse(state).deployment?.version ?? null;
}

const defaultFs = {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
};

/**
 * Runs one verb against a keyring file. Without `--apply` it reports the
 * plan and writes nothing. A missing keyring file reads as `k1` from
 * `--secret-file` (or the copy rotation moved aside).
 *
 * Host mode adds files. Rotate `--move-secret` moves the single secret to
 * `<secret-file>.k1` before writing the keyring, so an installer from before
 * the keyring fails on the missing file instead of deploying `k1` alone.
 * Retire `--installed` takes the activation time from the installer's record,
 * and refuses unless the node at `--state-url` runs the deployment that record
 * names with the current active key. Retiring `k1` deletes the moved secret.
 */
export function main(
  argv,
  {
    fs = defaultFs,
    now = Date.now(),
    random = () => randomBytes(48).toString("base64url"),
    liveVersion = liveDeploymentVersion,
  } = {},
) {
  const args = options(argv);
  const secretFile = args["secret-file"];
  const moved = secretFile && secretFile + MOVED_SECRET_SUFFIX;
  const present = fs.existsSync(args.file);
  let current;
  if (present) current = parseKeyring(fs.readFileSync(args.file, "utf8"));
  else {
    const source = [secretFile, moved].find((file) => file && fs.existsSync(file));
    if (!source) throw new Error("No keyring file and no single secret to start from");
    current = seedKeyring(fs.readFileSync(source, "utf8"));
  }
  const before = { ...describeKeyring(current), source: present ? "keyring" : "single secret" };
  if (args.verb === "show") return { keyring: before };

  if (args.verb === "rotate") {
    const { keyring, change } = rotateKeyring(current, { secret: random(), now, from: args.from });
    const result = { before, after: describeKeyring(keyring), ...change, applied: false };
    if (!args.apply) return result;
    if (args["move-secret"] && secretFile && fs.existsSync(secretFile))
      fs.renameSync(secretFile, moved);
    writeAtomic(fs, args.file, JSON.stringify(keyring, null, 2) + "\n");
    return { ...result, applied: true };
  }

  fenced(current, args.from);
  const removed = retiring(current, args.kid);
  // A leftover moved secret for a retired k1, from an interrupted retire.
  const cleanup = () => {
    if (moved && !Object.hasOwn(current.keys, LEGACY_KID) && fs.existsSync(moved)) fs.rmSync(moved);
  };
  if (!removed.length) {
    if (args.apply && present) cleanup();
    return { before, retired: [], nothing_to_do: true, applied: false };
  }
  let activatedAt = current.activated_at?.[current.active];
  if (args.installed) {
    const record = fs.existsSync(args.installed)
      ? JSON.parse(fs.readFileSync(args.installed, "utf8"))
      : null;
    if (record?.active !== current.active)
      throw new Error(
        `The installed Worker doesn't sign with ${current.active} yet; install the keyring before retiring`,
      );
    let live;
    try {
      live = liveVersion(args["state-url"]);
    } catch {
      live = undefined;
    }
    if (live !== record.deployment_version)
      throw new Error(
        `The running deployment (${live ?? "unknown"}) isn't the keyring install ${record.deployment_version}; install the keyring before retiring`,
      );
    activatedAt = record.activated_at;
  }
  const { keyring, change } = retireKeyring(current, {
    kid: args.kid,
    now,
    force: args.force,
    activatedAt,
    overlapDays: args["overlap-days"] ?? DEFAULT_OVERLAP_DAYS,
  });
  const overlapDays = args["overlap-days"] ?? DEFAULT_OVERLAP_DAYS;
  const result = {
    before,
    after: describeKeyring(keyring),
    ...change,
    signing_since: activatedAt ?? null,
    overlap_days: overlapDays,
    ...(activatedAt && {
      retire_after: new Date(
        Date.parse(activatedAt) + overlapDays * DAY_SECONDS * 1000,
      ).toISOString(),
    }),
    applied: false,
  };
  if (!args.apply) return result;
  writeAtomic(fs, args.file, JSON.stringify(keyring, null, 2) + "\n");
  current = keyring;
  cleanup();
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
