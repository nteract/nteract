import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_UNREACHABLE,
  SERVER_UNREACHABLE_ACTION,
  bannerMessages,
  failureMessage,
} from "./alerts.mjs";
import { request } from "./request.mjs";

async function failureOf(response) {
  try {
    await request("/api/tools", {}, { fetch: async () => response() });
  } catch (error) {
    return error;
  }
  throw Error("the request succeeded");
}

test("a failed action that reached no server reads as one plain sentence", async () => {
  for (const status of [502, 503, 504]) {
    for (const response of [
      () =>
        new Response("<html>Cloudflare</html>", {
          status,
          headers: { "Content-Type": "text/html" },
        }),
      () => Response.json({ error: "Pages request failed" }, { status }),
    ]) {
      const message = failureMessage(await failureOf(response));
      assert.equal(message, SERVER_UNREACHABLE_ACTION);
      assert.doesNotMatch(message, /\d{3}/);
    }
  }
  assert.equal(failureMessage(new TypeError("Failed to fetch")), SERVER_UNREACHABLE_ACTION);
  assert.equal(
    failureMessage(Object.assign(Error("Busy"), { status: 500, retryable: true })),
    SERVER_UNREACHABLE_ACTION,
  );
});

test("a failure the person can act on keeps its own message", async () => {
  for (const [status, error] of [
    [403, "You no longer have access to this Page."],
    [404, "Page not found"],
    [409, "This Page changed before it could move to Trash. Try again."],
    [500, "Storage is read-only"],
  ])
    assert.equal(
      failureMessage(await failureOf(() => Response.json({ error }, { status }))),
      error,
    );
  assert.equal(
    failureMessage(await failureOf(() => new Response("<html>", { status: 404 }))),
    "The server returned an unexpected response (404)",
  );
  assert.equal(
    failureMessage(Error("This Page link is not valid.")),
    "This Page link is not valid.",
  );
  assert.equal(failureMessage("Plain text"), "Plain text");
});

test("a screen shows each banner once", () => {
  const raw = "The server returned an unexpected response (503)";
  // The incident: the session refresh and the Page connection both reported it.
  assert.deepEqual(bannerMessages([raw, "", raw]), [raw]);
  assert.deepEqual(
    bannerMessages([SERVER_UNREACHABLE, undefined, ` ${SERVER_UNREACHABLE} `, null, false]),
    [SERVER_UNREACHABLE],
  );
  assert.deepEqual(bannerMessages(["First", "Second", "First"]), ["First", "Second"]);
  assert.deepEqual(
    bannerMessages(["Sign in again to sync this Page.", "Other"], {
      shown: ["Sign in again to sync this Page.", undefined],
    }),
    ["Other"],
    "a message another notice shows is not repeated",
  );
  assert.deepEqual(bannerMessages([]), []);
});
