import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_VIEWER_PROTOCOL,
  VIEWER_PROTOCOL,
  advertisementFromHeaders,
  compareBuild,
  readAdvertisement,
  strongerBuildState,
} from "../shared/build-identity.mjs";

const A = "aaaaaaaaaaaa",
  B = "bbbbbbbbbbbb";
const viewer = { build: A, protocol: 2 };

test("the viewer this build ships always meets this build's own floor", () => {
  assert.ok(Number.isSafeInteger(VIEWER_PROTOCOL) && VIEWER_PROTOCOL >= 1);
  assert.ok(Number.isSafeInteger(MIN_VIEWER_PROTOCOL) && MIN_VIEWER_PROTOCOL >= 1);
  assert.ok(MIN_VIEWER_PROTOCOL <= VIEWER_PROTOCOL);
});

test("build and protocol comparison", () => {
  const cases = [
    // [server advertisement, expected]
    [{ build: A, minViewerProtocol: 1 }, "current"],
    [{ build: A, minViewerProtocol: 2 }, "current"],
    [{ build: B, minViewerProtocol: 2 }, "update"],
    [{ build: B }, "update"],
    [{ build: A, minViewerProtocol: 3 }, "required"],
    [{ build: B, minViewerProtocol: 3 }, "required"],
    [{ minViewerProtocol: 3 }, "required"],
    // Unbundled Workers and unknown facts never ask for a reload.
    [{ build: "dev", minViewerProtocol: 1 }, "current"],
    [null, "current"],
    [{}, "current"],
    [{ build: "../../etc", minViewerProtocol: "lots" }, "current"],
    [{ build: B.toUpperCase() }, "current"],
  ];
  for (const [server, expected] of cases)
    assert.equal(compareBuild(server, viewer), expected, JSON.stringify(server));
  // An unbundled viewer only honors the protocol floor.
  assert.equal(compareBuild({ build: B }, { build: "dev", protocol: 2 }), "current");
  assert.equal(compareBuild({ minViewerProtocol: 3 }, { build: "dev", protocol: 2 }), "required");
});

test("advertisements parse from headers and keep valid fields only", () => {
  const headers = new Headers({ "X-Pages-Build": B, "X-Pages-Min-Viewer-Protocol": "4" });
  assert.deepEqual(advertisementFromHeaders(headers), { build: B, minViewerProtocol: 4 });
  assert.equal(advertisementFromHeaders(new Headers()), null);
  assert.equal(advertisementFromHeaders(undefined), null);
  assert.deepEqual(
    advertisementFromHeaders(
      new Headers({ "X-Pages-Build": "nope", "X-Pages-Min-Viewer-Protocol": "2" }),
    ),
    { build: undefined, minViewerProtocol: 2 },
  );
  for (const value of ["0", "-1", "1.5", "1e3", "99999999", ""])
    assert.equal(readAdvertisement({ minViewerProtocol: value }), null, value);
  assert.equal(readAdvertisement({ minViewerProtocol: 0 }), null);
});

test("states escalate and never fall back", () => {
  assert.equal(strongerBuildState("current", "update"), "update");
  assert.equal(strongerBuildState("update", "current"), "update");
  assert.equal(strongerBuildState("update", "required"), "required");
  assert.equal(strongerBuildState("required", "update"), "required");
});
