import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  clearLatestWorkstationBuildCacheForTests,
  getLatestWorkstationBuilds,
  isWorkstationBuildOutdated,
} from "../src/latest-workstation-builds.ts";

afterEach(() => {
  clearLatestWorkstationBuildCacheForTests();
});

describe("latest workstation builds", () => {
  it("fetches rolling updater manifests and keeps only the release facts", async () => {
    const calls: string[] = [];
    const builds = await getLatestWorkstationBuilds({
      baseUrl: "https://updates.test/nteract/releases/download",
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/nightly-latest/latest.json")) {
          return jsonResponse({
            version: "2.6.2-nightly.202607091009",
            pub_date: "2026-07-09T10:43:33Z",
            platforms: { "darwin-aarch64": { signature: "secret-ish" } },
          });
        }
        if (url.endsWith("/stable-latest/latest.json")) {
          return jsonResponse({
            version: "2.6.2",
            pub_date: "2026-07-08T10:43:33Z",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    assert.deepEqual(calls.sort(), [
      "https://updates.test/nteract/releases/download/nightly-latest/latest.json",
      "https://updates.test/nteract/releases/download/stable-latest/latest.json",
    ]);
    assert.deepEqual(builds, {
      stable: { version: "2.6.2", pubDate: "2026-07-08T10:43:33Z" },
      nightly: {
        version: "2.6.2-nightly.202607091009",
        pubDate: "2026-07-09T10:43:33Z",
      },
    });
  });

  it("treats fetch failures as unknown latest builds", async () => {
    const builds = await getLatestWorkstationBuilds({
      baseUrl: "https://updates.test/nteract/releases/download",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });

    assert.deepEqual(builds, {
      stable: null,
      nightly: null,
    });
  });

  it("bounds latest manifest fetches with an abort signal", async () => {
    const signals: AbortSignal[] = [];
    const builds = await getLatestWorkstationBuilds({
      baseUrl: "https://updates.test/nteract/releases/download",
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.ok(init?.signal instanceof AbortSignal);
        signals.push(init.signal);
        return new Response("unavailable", { status: 503 });
      },
    });

    assert.equal(signals.length, 2);
    assert.deepEqual(builds, {
      stable: null,
      nightly: null,
    });
  });

  it("derives outdated status from comparable build versions", () => {
    const latestNightly = "2.6.2-nightly.202607091009";
    assert.equal(
      isWorkstationBuildOutdated("2.6.2-nightly.202607091008+abc123", latestNightly),
      true,
    );
    assert.equal(
      isWorkstationBuildOutdated("2.6.2-nightly.202607091009+abc123", latestNightly),
      false,
    );
    assert.equal(
      isWorkstationBuildOutdated("2.6.2-nightly.202607091010+abc123", latestNightly),
      false,
    );
    assert.equal(isWorkstationBuildOutdated("2.6.1", "2.6.2"), true);
    assert.equal(isWorkstationBuildOutdated(null, latestNightly), false);
    assert.equal(isWorkstationBuildOutdated("2.6.1", null), false);
    assert.equal(isWorkstationBuildOutdated("not-a-build", latestNightly), false);
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
