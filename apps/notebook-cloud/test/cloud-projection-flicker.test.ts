import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The store-level flicker contract lives in the shared projection lifecycle
// tests. This file pins the cloud session wiring that cannot run under node
// because the hook imports the component-bearing notebook surface.
describe("cloud projection flicker wiring", () => {
  const sessionSource = readFileSync(
    new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
    "utf8",
  );

  it("imports projection lifecycle from the shared notebook state module", () => {
    assert.match(
      sessionSource,
      /from ["']@\/components\/notebook\/state\/projection-lifecycle["']/,
    );
    assert.doesNotMatch(sessionSource, /notebook-view-store-bridge/);
  });

  it("clears real notebook switches in the next run's body before connecting", () => {
    // The cleanup closes over its own run's config, so switch-clearing can
    // only happen here. A cleared switch also drops the race flags because a
    // cleared stage has no pixels for either flag to describe.
    assert.match(
      sessionSource,
      /const preservedAcrossRuns = resetNotebookProjectionUnlessPreserved\(\{\s*previousIdentity: paintedNotebookIdentityRef\.current,\s*nextIdentity: `id:\$\{config\.notebookId\}`,\s*\}\);\s*if \(!preservedAcrossRuns\) \{\s*paintedNotebookIdentityRef\.current = null;/,
    );
    assert.match(
      sessionSource,
      /if \(!preservedAcrossRuns\) \{[\s\S]*?liveMaterializedRef\.current = false;\s*paintOriginRef\.current = false;\s*\}/,
    );
  });

  it("gates the live cleanup with only the pool reset unconditional", () => {
    assert.match(
      sessionSource,
      /resetNotebookProjectionUnlessPreserved\(\{\s*previousIdentity: paintedNotebookIdentityRef\.current,\s*nextIdentity: `id:\$\{config\.notebookId\}`,\s*\}\);\s*resetPoolState\(\);/,
    );
  });

  it("tracks the painted notebook identity only when cells actually painted", () => {
    assert.match(
      sessionSource,
      /if \(resolvedCells\.length > 0\) \{\s*paintedNotebookIdentityRef\.current = `id:\$\{config\.notebookId\}`;\s*\}/,
    );
  });

  it("keeps an unconditional full shared projection clear on true unmount", () => {
    assert.match(
      sessionSource,
      /useEffect\(\s*\(\) => \(\) => \{\s*resetNotebookProjectionStores\(\);\s*\},\s*\[\],\s*\);/,
    );
  });

  it("keys live-room reconnects by effective auth credentials, not auth object identity", () => {
    assert.match(
      sessionSource,
      /const syncAuthConnectionKey = cloudSyncAuthConnectionKey\(authState, \{ hasAppSession \}\);/,
    );
    assert.match(
      sessionSource,
      /const authStateRef = useRef\(authState\);\s*authStateRef\.current = authState;[\s\S]*const hasAppSessionRef = useRef\(hasAppSession\);/,
    );
    const liveRoomDependencies = sessionSource.match(
      /\[\s*blobResolver,[\s\S]*?widgetStore,\s*\]\);/,
    )?.[0];
    assert.ok(liveRoomDependencies, "live-room dependency list should be identifiable");
    assert.match(
      liveRoomDependencies,
      /connectAttempt,\s*syncAuthConnectionKey,\s*loadingPolicy\.shouldConnectLiveRoom,/,
    );
    assert.doesNotMatch(
      liveRoomDependencies,
      /\bauthRenewalKind\b|\bauthState\b|\bhasAppSession\b/,
    );
  });
});
