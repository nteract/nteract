import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureFetch, fixtureWhoamiUrl, generateFixtureKeys } from "./fixtures/local-api-keys.mjs";

test("local provider denies unknown keys and external network access", async () => {
  const { keys, responses } = generateFixtureKeys();
  const calls = [];
  const fetch = fixtureFetch("http://localhost:1234", responses, async (url) => {
    calls.push(url);
    return new Response("local");
  });
  assert.equal((await fetch(fixtureWhoamiUrl)).status, 401);
  const identity = await (
    await fetch(fixtureWhoamiUrl, {
      headers: { Authorization: `Bearer ${keys.editor}` },
    })
  ).json();
  assert.equal(identity.passport.user_id, "alice@localhost");
  assert.deepEqual(identity.passport.scopes, ["cloud:read", "cloud:write"]);
  assert.deepEqual(responses[keys.reader].passport.scopes, ["cloud:read"]);
  await assert.rejects(
    fetch("https://auth.anaconda.com/api/auth/sessions/whoami"),
    /external network/,
  );
  await assert.rejects(fetch("http://localhost:9999/health"), /external network/);
  assert.equal((await fetch("http://localhost:1234/health")).status, 200);
  assert.equal(calls.length, 1);
  assert.throws(() => fixtureFetch("https://pages.example", responses, fetch), /localhost/);
  assert.equal(
    Object.keys(responses).some((key) => Object.hasOwn(generateFixtureKeys().responses, key)),
    false,
  );
});
