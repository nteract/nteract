import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertHostedCollabSmokeEnv,
  browserDevTokenForSmoke,
  storageStateForDevIdentity,
  viewerUrlForRoom,
} from "../scripts/hosted-collab-smoke-env.mjs";

describe("hosted browser collaboration smoke environment", () => {
  it("allows loopback browser smoke without a real dev token", () => {
    assert.doesNotThrow(() =>
      assertHostedCollabSmokeEnv({
        baseUrl: "http://127.0.0.1:8787",
        devAuthToken: undefined,
      }),
    );
    assert.equal(
      browserDevTokenForSmoke({
        baseUrl: "http://localhost:8787",
        devAuthToken: undefined,
      }),
      "local-dev-token",
    );
  });

  it("requires an environment dev token when targeting a deployed Worker", () => {
    assert.throws(
      () =>
        assertHostedCollabSmokeEnv({
          baseUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
          devAuthToken: undefined,
        }),
      /NOTEBOOK_CLOUD_DEV_TOKEN is required/,
    );
    assert.throws(
      () =>
        browserDevTokenForSmoke({
          baseUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
          devAuthToken: undefined,
        }),
      /NOTEBOOK_CLOUD_DEV_TOKEN is required/,
    );
  });

  it("builds the viewer URL without credential material", () => {
    const url = viewerUrlForRoom(
      "https://nteract-notebook-cloud.rgbkrk.workers.dev",
      "room/with/slashes",
    );
    const parsed = new URL(url);

    assert.equal(
      url,
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/room%2Fwith%2Fslashes/collab",
    );
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
  });

  it("stores browser dev identity in localStorage state", () => {
    const state = storageStateForDevIdentity({
      origin: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
      token: "token-from-env",
      user: "alice",
      scope: "owner",
    });

    assert.deepEqual(state, {
      origins: [
        {
          origin: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
          localStorage: [
            { name: "nteract:notebook-cloud:dev-token", value: "token-from-env" },
            { name: "nteract:notebook-cloud:user", value: "alice" },
            { name: "nteract:notebook-cloud:scope", value: "owner" },
          ],
        },
      ],
    });
  });
});
