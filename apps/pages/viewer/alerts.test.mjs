import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_UNREACHABLE,
  SERVER_UNREACHABLE_ACTION,
  bannerMessages,
  SESSION_ENDED,
  failureMessage,
  screenBanners,
  sessionAnswerNotice,
  sessionCheckBanner,
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

test("the session-check banner waits for an outage when the account is known", () => {
  const down = Object.assign(Error("The server returned an unexpected response (503)"), {
    status: 503,
  });
  assert.equal(sessionCheckBanner(down, { outage: false, signedIn: true }), undefined);
  assert.equal(sessionCheckBanner(down, { outage: true, signedIn: true }), SERVER_UNREACHABLE);
  // A first check has nothing else on screen.
  assert.equal(sessionCheckBanner(down, { signedIn: false }), SERVER_UNREACHABLE_ACTION);
  // A failure the server answered keeps its message.
  assert.equal(
    sessionCheckBanner(Object.assign(Error("Storage is read-only"), { status: 500 }), {
      signedIn: true,
    }),
    "Storage is read-only",
  );
});

test("a refused session says why only for a tab that was signed in", () => {
  const expired = Object.assign(Error("Session expired"), { status: 401 });
  const forbidden = Object.assign(Error("Sign in with a verified anaconda.com email."), {
    status: 403,
  });
  assert.deepEqual(sessionAnswerNotice(expired, { signedIn: true }), {
    message: SESSION_ENDED,
    signIn: true,
  });
  assert.deepEqual(sessionAnswerNotice(forbidden, { signedIn: true }), {
    message: "Sign in with a verified anaconda.com email.",
    signIn: true,
  });
  assert.equal(sessionAnswerNotice(expired, { signedIn: false }), null);
  assert.equal(sessionAnswerNotice(undefined, { signedIn: true }), null);
});

test("one banner region per screen", () => {
  const prompt = "Sign in again to sync this Page. Keep it open while you sign in.";
  const page = { problem: "", authRequired: false, authProblem: "", accessProblem: "" };
  const signIn = { message: SESSION_ENDED, signIn: true };
  const outage = { message: SERVER_UNREACHABLE, signIn: false };
  assert.deepEqual(screenBanners({ sessionNotice: signIn }), [SESSION_ENDED]);
  assert.deepEqual(
    screenBanners({ sessionNotice: outage, page: { ...page, problem: SERVER_UNREACHABLE } }),
    [SERVER_UNREACHABLE],
  );
  // The Page's own sign-in prompt stands in for the sign-in notice, and a
  // sync problem from before sign-in is not shown beside it.
  assert.deepEqual(
    screenBanners({
      sessionNotice: signIn,
      page: { ...page, authRequired: true, authProblem: prompt, problem: SERVER_UNREACHABLE },
    }),
    [],
  );
  assert.deepEqual(screenBanners({ error: "Couldn't copy the link.", sessionNotice: null, page }), [
    "Couldn't copy the link.",
  ]);
});
