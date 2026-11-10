import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionKeyring } from "@cloud/session-keyring.ts";
import { OAUTH_REFRESH_SECONDS } from "../shared/oauth-grant.mjs";
import {
  DEFAULT_OVERLAP_DAYS,
  OAUTH_OVERLAP_DAYS,
  SESSION_OVERLAP_DAYS,
  hostKeyCommand,
  installedRecord,
  main,
  parseKeyring,
  retireKeyring,
  rotateKeyring,
  seedKeyring,
  sessionVars,
  withSessionVars,
} from "./deployment/session-keys.mjs";
import { SERVER_SESSION_ABSOLUTE_SECONDS } from "@cloud/oidc-session-store.ts";

const A = "a".repeat(32);
const B = "b".repeat(48);
const C = "c".repeat(40);
const D = "d".repeat(33);
const NOW = Date.parse("2026-11-06T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

test("the installer helper and the Worker accept and refuse the same keyrings", () => {
  const cases = [
    { active: "k1", keys: { k1: A } },
    { active: "k2", keys: { k1: A, k2: B }, activated_at: { k2: "2026-11-06T00:00:00Z" } },
    { active: "key_4-x", keys: { k1: A, k2: B, k3: C, "key_4-x": D } },
    { active: "k1", keys: { k1: A, k2: B, k3: C, k4: D, k5: A + "e" } },
    { active: "k1", keys: {} },
    { active: "k.1", keys: { "k.1": A } },
    { active: "k1", keys: { k1: "x".repeat(31) } },
    { active: "k1", keys: { k1: "é".repeat(16) } },
    { active: "k1", keys: { k1: "é".repeat(15) } },
    { active: "k1", keys: { k1: ` ${A}` } },
    { active: "k1", keys: { k1: A, k2: A } },
    { active: "k3", keys: { k1: A } },
    { keys: { k1: A } },
    { active: "k1", keys: { k1: A }, extra: true },
    { active: "k1", keys: { k1: A }, activated_at: { k1: "later" } },
    { active: "k1", keys: { k1: A }, activated_at: { k9: "2026-11-06T00:00:00Z" } },
    { active: "k1", keys: { k1: 1 } },
    [],
    "k1",
  ];
  const accepts = (parse, text) => {
    try {
      parse(text);
      return true;
    } catch {
      return false;
    }
  };
  for (const value of [...cases.map((value) => JSON.stringify(value)), "{"])
    assert.equal(
      accepts(parseKeyring, value),
      accepts(parseSessionKeyring, value),
      `both validators agree on ${value}`,
    );
});

test("the overlap constants match the session and OAuth grant lifetimes they stand for", () => {
  assert.equal(SESSION_OVERLAP_DAYS * DAY, SERVER_SESSION_ABSOLUTE_SECONDS * 1000);
  assert.equal(OAUTH_OVERLAP_DAYS * DAY, OAUTH_REFRESH_SECONDS * 1000);
  assert.equal(DEFAULT_OVERLAP_DAYS, OAUTH_OVERLAP_DAYS);
});

test("installer vars read the single secret only without a keyring file", () => {
  assert.deepEqual(sessionVars({ secret: () => ` ${A}\n` }), {
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: A,
  });
  const keyring = { active: "k2", keys: { k1: A, k2: B } };
  const unread = () => assert.fail("the single secret is not read with a keyring");
  assert.deepEqual(sessionVars({ keyring: JSON.stringify(keyring, null, 2), secret: unread }), {
    NOTEBOOK_CLOUD_APP_SESSION_KEYS: JSON.stringify(keyring),
  });
  assert.throws(
    () => sessionVars({ keyring: '{"active":"k1","keys":{}}', secret: unread }),
    /1 to 4 keys/,
  );
});

test("older release configs get the current session vars and keep everything else", () => {
  const vars = { NOTEBOOK_CLOUD_APP_SESSION_KEYS: "{}" };
  assert.deepEqual(
    withSessionVars(
      {
        main: "index.js",
        vars: { PAGES_RECORD_STORAGE: "automerge", NOTEBOOK_CLOUD_APP_SESSION_SECRET: A },
      },
      vars,
    ),
    { main: "index.js", vars: { PAGES_RECORD_STORAGE: "automerge", ...vars } },
  );
});

test("rotate seeds k1 from the single secret, adds the next kid and makes it active", () => {
  const seeded = seedKeyring(A);
  assert.deepEqual(seeded, { active: "k1", keys: { k1: A } });
  assert.throws(() => seedKeyring(`${A}\n`), /surrounding whitespace/);
  const { keyring, change } = rotateKeyring(seeded, { secret: B, now: NOW, from: "k1" });
  assert.deepEqual(keyring, {
    active: "k2",
    keys: { k1: A, k2: B },
    activated_at: { k2: "2026-11-06T08:00:00.000Z" },
  });
  assert.deepEqual(change, { rotated: { from: "k1", to: "k2" } });
  const again = rotateKeyring(keyring, { secret: C, now: NOW + DAY });
  assert.equal(again.keyring.active, "k3");
  assert.deepEqual(Object.keys(again.keyring.keys), ["k1", "k2", "k3"]);
});

test("rotate refuses a stale fence, a fifth key and a reused secret", () => {
  const keyring = { active: "k2", keys: { k1: A, k2: B } };
  assert.throws(
    () => rotateKeyring(keyring, { secret: C, now: NOW, from: "k1" }),
    /active key is k2, not k1/,
  );
  const full = { active: "k4", keys: { k1: A, k2: B, k3: C, k4: D } };
  assert.throws(() => rotateKeyring(full, { secret: A + "x", now: NOW }), /retire one first/);
  assert.throws(() => rotateKeyring(keyring, { secret: A, now: NOW }), /share a secret/);
});

test("retire waits the overlap after the Worker began signing with the active key", () => {
  const keyring = { active: "k2", keys: { k1: A, k2: B } };
  const signing = new Date(NOW).toISOString();
  for (const [overlapDays, due] of [
    [7, "2026-11-13T08:00:00.000Z"],
    [30, "2026-12-06T08:00:00.000Z"],
  ]) {
    assert.throws(
      () =>
        retireKeyring(keyring, {
          now: NOW + overlapDays * DAY - 1,
          activatedAt: signing,
          overlapDays,
        }),
      new RegExp(`Values signed with k1 may stay in use until ${due}`),
    );
    const retired = retireKeyring(keyring, {
      now: NOW + overlapDays * DAY,
      activatedAt: signing,
      overlapDays,
    });
    assert.deepEqual(retired.keyring, { active: "k2", keys: { k2: B } });
    assert.deepEqual(retired.change, { retired: ["k1"] });
  }
  // The default overlap is the OAuth grant lifetime.
  assert.throws(() => retireKeyring(keyring, { now: NOW + 8 * DAY, activatedAt: signing }));
  assert.deepEqual(retireKeyring({ active: "k2", keys: { k2: B } }, { now: NOW }).change, {
    retired: [],
    nothing_to_do: true,
  });
  assert.deepEqual(Object.keys(retireKeyring(keyring, { now: NOW, force: true }).keyring.keys), [
    "k2",
  ]);
});

test("retire refuses the active key, an unknown kid, a stale fence and an unknown activation", () => {
  const keyring = { active: "k3", keys: { k1: A, k2: B, k3: C } };
  const activatedAt = new Date(NOW).toISOString();
  assert.throws(() => retireKeyring(keyring, { kid: "k3", now: NOW }), /Rotate to a new key/);
  assert.throws(() => retireKeyring(keyring, { kid: "k9", now: NOW }), /No key k9/);
  assert.throws(() => retireKeyring(keyring, { now: NOW, from: "k2" }), /not k2/);
  const one = retireKeyring(keyring, { kid: "k1", now: NOW + 30 * DAY, activatedAt });
  assert.deepEqual(Object.keys(one.keyring.keys), ["k2", "k3"]);
  assert.throws(() => retireKeyring(keyring, { now: NOW + 90 * DAY }), /--force/);
});

test("the installer's activation record carries forward only along one deployment line", () => {
  const first = installedRecord({
    previous: null,
    active: "k2",
    liveBefore: "v1",
    deployedVersion: "v2",
    now: NOW,
  });
  assert.deepEqual(first, {
    active: "k2",
    activated_at: "2026-11-06T08:00:00.000Z",
    deployment_version: "v2",
  });
  // A reinstall with the same key on top of the recorded deployment keeps the time.
  assert.deepEqual(
    installedRecord({
      previous: first,
      active: "k2",
      liveBefore: "v2",
      deployedVersion: "v3",
      now: NOW + DAY,
    }),
    { ...first, deployment_version: "v3" },
  );
  // A rollback or failed install in between, a new active key, or an unknown
  // live deployment restarts the overlap.
  for (const [active, liveBefore] of [
    ["k2", "v9"],
    ["k2", null],
    ["k3", "v2"],
  ])
    assert.equal(
      installedRecord({
        previous: first,
        active,
        liveBefore,
        deployedVersion: "v3",
        now: NOW + DAY,
      }).activated_at,
      "2026-11-07T08:00:00.000Z",
    );
  assert.equal(
    installedRecord({
      previous: first,
      active: undefined,
      liveBefore: "v2",
      deployedVersion: "v3",
      now: NOW,
    }),
    null,
  );
});

function memoryFs(files) {
  const writes = [];
  const open = new Map();
  let next = 3;
  return {
    files,
    writes,
    existsSync: (file) => Object.hasOwn(files, file),
    readFileSync: (file) => files[file],
    openSync(file, flags, mode) {
      const fd = next++;
      open.set(fd, { file, mode, synced: false, text: "" });
      return fd;
    },
    fchmodSync(fd, mode) {
      open.get(fd).mode = mode;
    },
    writeSync(fd, text) {
      open.get(fd).text += text;
    },
    fsyncSync(fd) {
      open.get(fd).synced = true;
    },
    closeSync(fd) {
      const { file, mode, synced, text } = open.get(fd);
      writes.push({ file, mode, synced });
      files[file] = text;
      open.delete(fd);
    },
    renameSync(from, to) {
      files[to] = files[from];
      delete files[from];
    },
    rmSync(file) {
      delete files[file];
    },
  };
}

test("rotate on a host moves the single secret aside and applies only against the planned kid", () => {
  const fs = memoryFs({ "/etc/s/session-secret": A });
  const argv = [
    "rotate",
    "--file",
    "/etc/s/session-keys.json",
    "--secret-file",
    "/etc/s/session-secret",
    "--move-secret",
  ];
  const random = () => B;
  const plan = main(argv, { fs, now: NOW, random });
  assert.deepEqual(plan, {
    before: { active: "k1", kids: ["k1"], source: "single secret" },
    after: { active: "k2", kids: ["k1", "k2"], activated_at: { k2: "2026-11-06T08:00:00.000Z" } },
    rotated: { from: "k1", to: "k2" },
    applied: false,
  });
  assert.deepEqual(fs.writes, []);
  assert.ok(fs.files["/etc/s/session-secret"]);
  assert.throws(() => main([...argv, "--apply"], { fs, now: NOW, random }), /--from ACTIVE_KID/);

  const applied = main([...argv, "--apply", "--from", "k1"], { fs, now: NOW, random });
  assert.equal(applied.applied, true);
  assert.deepEqual(fs.writes, [
    { file: "/etc/s/session-keys.json.next", mode: 0o600, synced: true },
  ]);
  assert.deepEqual(parseKeyring(fs.files["/etc/s/session-keys.json"]).keys, { k1: A, k2: B });
  assert.equal(fs.files["/etc/s/session-secret"], undefined, "an old installer fails on it");
  assert.equal(fs.files["/etc/s/session-secret.k1"], A);
  for (const output of [plan, applied])
    assert.doesNotMatch(JSON.stringify(output), new RegExp(`${A}|${B}`));
  // A retry of the same apply finds k2 active and refuses to add a third key.
  assert.throws(
    () => main([...argv, "--apply", "--from", "k1"], { fs, now: NOW, random: () => C }),
    /active key is k2, not k1/,
  );
});

test("an interrupted rotate resumes from the moved secret", () => {
  const fs = memoryFs({ "/etc/s/session-secret.k1": A });
  const result = main(
    [
      "rotate",
      "--file",
      "/etc/s/k.json",
      "--secret-file",
      "/etc/s/session-secret",
      "--move-secret",
      "--apply",
      "--from",
      "k1",
    ],
    { fs, now: NOW, random: () => B },
  );
  assert.equal(result.applied, true);
  assert.deepEqual(parseKeyring(fs.files["/etc/s/k.json"]).keys, { k1: A, k2: B });
});

test("retire on a host waits for the installed keyring and its overlap, then deletes the moved secret", () => {
  const keyring = {
    active: "k2",
    keys: { k1: A, k2: B },
    activated_at: { k2: new Date(NOW).toISOString() },
  };
  const installed = {
    active: "k2",
    activated_at: new Date(NOW + 2 * DAY).toISOString(),
    deployment_version: "v2",
  };
  const files = () => ({
    "/etc/s/k.json": JSON.stringify(keyring),
    "/etc/s/session-secret.k1": A,
    "/etc/s/active.json": JSON.stringify(installed),
  });
  const argv = [
    "retire",
    "--file",
    "/etc/s/k.json",
    "--secret-file",
    "/etc/s/session-secret",
    "--installed",
    "/etc/s/active.json",
    "--state-url",
    "http://127.0.0.1:19480/state",
    "--overlap-days",
    "30",
  ];
  const apply = [...argv, "--apply", "--from", "k2"];
  const urls = [];
  const live = (version) => (url) => {
    urls.push(url);
    return version;
  };

  // Rotated but not installed: no record for k2.
  let fs = memoryFs({
    ...files(),
    "/etc/s/active.json": JSON.stringify({ ...installed, active: "k1" }),
  });
  assert.throws(
    () => main(apply, { fs, now: NOW + 90 * DAY, liveVersion: live("v2") }),
    /install the keyring/,
  );
  // Installed, but the node runs something else (a rollback).
  fs = memoryFs(files());
  assert.throws(
    () => main(apply, { fs, now: NOW + 90 * DAY, liveVersion: live("v1") }),
    /running deployment \(v1\)/,
  );
  assert.throws(
    () =>
      main(apply, {
        fs,
        now: NOW + 90 * DAY,
        liveVersion: () => {
          throw new Error("down");
        },
      }),
    /running deployment \(unknown\)/,
  );
  // The overlap counts from the install, not the rotation.
  assert.throws(
    () => main(apply, { fs, now: NOW + 31 * DAY, liveVersion: live("v2") }),
    /until 2026-12-08T08:00:00.000Z/,
  );
  const plan = main(argv, { fs, now: NOW + 32 * DAY, liveVersion: live("v2") });
  assert.equal(plan.signing_since, installed.activated_at);
  assert.equal(plan.retire_after, "2026-12-08T08:00:00.000Z");
  assert.equal(plan.applied, false);
  const done = main(apply, { fs, now: NOW + 32 * DAY, liveVersion: live("v2") });
  assert.deepEqual(done.retired, ["k1"]);
  assert.equal(done.applied, true);
  assert.equal(fs.files["/etc/s/session-secret.k1"], undefined);
  assert.deepEqual(Object.keys(parseKeyring(fs.files["/etc/s/k.json"]).keys), ["k2"]);
  assert.deepEqual(urls.at(-1), "http://127.0.0.1:19480/state");
  // A retry reports there is nothing left to retire.
  assert.deepEqual(main(apply, { fs, now: NOW + 32 * DAY, liveVersion: live("v2") }), {
    before: { active: "k2", kids: ["k2"], activated_at: keyring.activated_at, source: "keyring" },
    retired: [],
    nothing_to_do: true,
    applied: false,
  });
});

test("the CLI refuses unknown flags, a short overlap and a host with neither keyring nor secret", () => {
  const fs = memoryFs({});
  assert.throws(() => main(["rotate", "--file", "/k"], { fs }), /no single secret/);
  assert.throws(() => main(["rotate", "--file", "/k", "--force"], { fs }), /Usage/);
  assert.throws(() => main(["retire", "--file", "/k", "--move-secret"], { fs }), /Usage/);
  assert.throws(() => main(["retire", "--file", "/k", "--installed", "/r"], { fs }), /Usage/);
  assert.throws(
    () => main(["retire", "--file", "/k", "--overlap-days", "6"], { fs }),
    /at least 7/,
  );
  assert.throws(() => main(["rotate"], { fs }), /Usage/);
  assert.throws(() => main(["shred", "--file", "/k"], { fs }), /Usage/);
});

test("deploy.mjs maps rotate-key and retire-key onto the service's own files", () => {
  const deployment = { service: "nteract-page10", internalListen: "127.0.0.1:19480" };
  assert.deepEqual(hostKeyCommand("rotate-key", [], deployment), [
    "rotate",
    "--file",
    "/etc/nteract-page10/session-keys.json",
    "--secret-file",
    "/etc/nteract-page10/session-secret",
    "--move-secret",
  ]);
  assert.deepEqual(
    hostKeyCommand(
      "retire-key",
      ["--kid", "k1", "--force", "--apply", "--from", "k2"],
      deployment,
      {
        overlapDays: 30,
      },
    ),
    [
      "retire",
      "--file",
      "/etc/nteract-page10/session-keys.json",
      "--secret-file",
      "/etc/nteract-page10/session-secret",
      "--installed",
      "/etc/nteract-page10/session-keys-active.json",
      "--state-url",
      "http://127.0.0.1:19480/state",
      "--overlap-days",
      "30",
      "--kid",
      "k1",
      "--force",
      "--apply",
      "--from",
      "k2",
    ],
  );
  for (const options of [["--kid", "k1"], ["--force"], ["--from", "k;1"], ["--from"], ["extra"]])
    assert.throws(() => hostKeyCommand("rotate-key", options, deployment), /Usage/);
  assert.throws(
    () => hostKeyCommand("rotate-key", [], { ...deployment, service: "../etc" }),
    /Usage/,
  );
  assert.throws(() => hostKeyCommand("rotate-key", ["--apply"], deployment), /--from ACTIVE_KID/);
});
