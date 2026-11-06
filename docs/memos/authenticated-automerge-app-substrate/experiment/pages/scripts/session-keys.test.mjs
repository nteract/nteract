import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionKeyring } from "@cloud/session-keyring.ts";
import {
  OVERLAP_MS,
  hostKeyCommand,
  main,
  parseKeyring,
  retireKeyring,
  rotateKeyring,
  seedKeyring,
  sessionVars,
} from "./deployment/session-keys.mjs";

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

test("installer vars keep the single secret without a keyring file", () => {
  assert.deepEqual(sessionVars({ secret: ` ${A}\n` }), {
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: A,
  });
  const keyring = { active: "k2", keys: { k1: A, k2: B } };
  assert.deepEqual(sessionVars({ keyring: JSON.stringify(keyring, null, 2), secret: C }), {
    NOTEBOOK_CLOUD_APP_SESSION_KEYS: JSON.stringify(keyring),
  });
  assert.throws(
    () => sessionVars({ keyring: '{"active":"k1","keys":{}}', secret: C }),
    /1 to 4 keys/,
  );
});

test("rotate seeds k1 from the single secret, adds the next kid and makes it active", () => {
  const seeded = seedKeyring(`${A}\n`);
  assert.deepEqual(seeded, { active: "k1", keys: { k1: A } });
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

test("retire waits out the session lifetime after the active key's activation", () => {
  const keyring = {
    active: "k2",
    keys: { k1: A, k2: B },
    activated_at: { k2: new Date(NOW).toISOString() },
  };
  assert.equal(OVERLAP_MS, 7 * DAY);
  assert.throws(
    () => retireKeyring(keyring, { now: NOW + 7 * DAY - 1 }),
    /Sessions under k1 may last until 2026-11-13T08:00:00.000Z/,
  );
  const retired = retireKeyring(keyring, { now: NOW + 7 * DAY });
  assert.deepEqual(retired.keyring, {
    active: "k2",
    keys: { k2: B },
    activated_at: { k2: new Date(NOW).toISOString() },
  });
  assert.deepEqual(retired.change, { retired: ["k1"] });
  assert.deepEqual(retireKeyring(retired.keyring, { now: NOW + 8 * DAY }).change, {
    retired: [],
  });
  const forced = retireKeyring(keyring, { now: NOW, force: true });
  assert.deepEqual(Object.keys(forced.keyring.keys), ["k2"]);
});

test("retire refuses the active key, an unknown kid, a stale fence and an unknown activation", () => {
  const keyring = {
    active: "k3",
    keys: { k1: A, k2: B, k3: C },
    activated_at: { k3: new Date(NOW).toISOString() },
  };
  assert.throws(() => retireKeyring(keyring, { kid: "k3", now: NOW }), /Rotate to a new key/);
  assert.throws(() => retireKeyring(keyring, { kid: "k9", now: NOW }), /No key k9/);
  assert.throws(() => retireKeyring(keyring, { now: NOW, from: "k2" }), /not k2/);
  const one = retireKeyring(keyring, { kid: "k1", now: NOW + 7 * DAY });
  assert.deepEqual(Object.keys(one.keyring.keys), ["k2", "k3"]);
  const unrecorded = { active: "k2", keys: { k1: A, k2: B } };
  assert.throws(() => retireKeyring(unrecorded, { now: NOW + 30 * DAY }), /--force/);
});

function memoryFs(files) {
  const writes = [];
  return {
    files,
    writes,
    existsSync: (file) => Object.hasOwn(files, file),
    readFileSync: (file) => files[file],
    writeFileSync(file, text, options) {
      writes.push({ file, mode: options?.mode });
      files[file] = text;
    },
    renameSync(from, to) {
      files[to] = files[from];
      delete files[from];
    },
  };
}

test("the CLI plans without writing and applies only against the planned active kid", () => {
  const fs = memoryFs({ "/etc/s/session-secret": `${A}\n` });
  const argv = [
    "rotate",
    "--file",
    "/etc/s/session-keys.json",
    "--secret-file",
    "/etc/s/session-secret",
  ];
  const random = () => B;
  const plan = main(argv, { fs, now: NOW, random });
  assert.deepEqual(plan, {
    before: { active: "k1", kids: ["k1"], source: "single secret" },
    after: {
      active: "k2",
      kids: ["k1", "k2"],
      activated_at: { k2: "2026-11-06T08:00:00.000Z" },
      retire_after: "2026-11-13T08:00:00.000Z",
    },
    rotated: { from: "k1", to: "k2" },
    applied: false,
  });
  assert.deepEqual(fs.writes, []);
  assert.throws(() => main([...argv, "--apply"], { fs, now: NOW, random }), /--from ACTIVE_KID/);

  const applied = main([...argv, "--apply", "--from", "k1"], { fs, now: NOW, random });
  assert.equal(applied.applied, true);
  assert.deepEqual(fs.writes, [{ file: "/etc/s/session-keys.json.next", mode: 0o600 }]);
  assert.deepEqual(parseKeyring(fs.files["/etc/s/session-keys.json"]).keys, { k1: A, k2: B });
  for (const output of [plan, applied]) {
    assert.doesNotMatch(JSON.stringify(output), new RegExp(`${A}|${B}`));
  }
  // A retry of the same apply finds k2 active and refuses to add a third key.
  assert.throws(
    () => main([...argv, "--apply", "--from", "k1"], { fs, now: NOW, random: () => C }),
    /active key is k2, not k1/,
  );

  const retire = ["retire", "--file", "/etc/s/session-keys.json"];
  assert.throws(
    () => main([...retire, "--apply", "--from", "k2"], { fs, now: NOW }),
    /retire after/,
  );
  const retired = main([...retire, "--apply", "--from", "k2"], { fs, now: NOW + 7 * DAY });
  assert.deepEqual(retired.retired, ["k1"]);
  assert.deepEqual(main(["show", "--file", "/etc/s/session-keys.json"], { fs }), {
    keyring: {
      active: "k2",
      kids: ["k2"],
      activated_at: { k2: "2026-11-06T08:00:00.000Z" },
      retire_after: "2026-11-13T08:00:00.000Z",
      source: "keyring",
    },
  });
});

test("the CLI refuses unknown flags and a host with neither keyring nor secret", () => {
  const fs = memoryFs({});
  assert.throws(() => main(["rotate", "--file", "/k"], { fs }), /no single secret/);
  assert.throws(() => main(["rotate", "--file", "/k", "--force"], { fs }), /Usage/);
  assert.throws(() => main(["rotate"], { fs }), /Usage/);
  assert.throws(() => main(["shred", "--file", "/k"], { fs }), /Usage/);
});

test("deploy.mjs maps rotate-key and retire-key onto the service's own files", () => {
  assert.deepEqual(hostKeyCommand("rotate-key", [], "nteract-page10"), [
    "rotate",
    "--file",
    "/etc/nteract-page10/session-keys.json",
    "--secret-file",
    "/etc/nteract-page10/session-secret",
  ]);
  assert.deepEqual(
    hostKeyCommand(
      "retire-key",
      ["--kid", "k1", "--force", "--apply", "--from", "k2"],
      "svc",
    ).slice(5),
    ["--kid", "k1", "--force", "--apply", "--from", "k2"],
  );
  for (const options of [["--kid", "k1"], ["--force"], ["--from", "k;1"], ["--from"], ["extra"]])
    assert.throws(() => hostKeyCommand("rotate-key", options, "svc"), /Usage/);
  assert.throws(() => hostKeyCommand("rotate-key", [], "../etc"), /Usage/);
  assert.throws(() => hostKeyCommand("rotate-key", ["--apply"], "svc"), /--from ACTIVE_KID/);
});
