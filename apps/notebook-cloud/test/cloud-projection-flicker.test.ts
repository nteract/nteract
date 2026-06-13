import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCellIdsSnapshot } from "@/components/notebook/state/cell-store";
import {
  getCellExecutionId,
  getExecutionById,
  resetNotebookExecutions,
} from "@/components/notebook/state/execution-store";
import { getOutputById, resetNotebookOutputs } from "@/components/notebook/state/output-store";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudProjectionUnlessPreserved,
  resetCloudViewStoreProjection,
} from "../viewer/notebook-view-store-bridge.ts";
import type { ResolvedCell } from "../viewer/render-resolution.ts";

// Field-observed flicker: with IndexedDB seeding, the persisted snapshot
// paints cells (and their outputs) well before the live-room effect
// settles. The effect re-runs for reasons that are NOT a notebook switch,
// and clearing ANY of the projected stores on those re-runs blanks the
// notebook into a full→empty→full flash. CodeCell renders outputs and
// execution counts exclusively through the execution/output stores, so the
// gate must keep or clear ALL projected stores together — these tests run
// the real gate against the real stores.
describe("cloud projection flicker gate", () => {
  const PAINTED = "id:nb-1";

  afterEach(() => {
    resetCloudViewStoreProjection();
    resetNotebookExecutions();
    resetNotebookOutputs();
  });

  function paintNotebook(): void {
    projectCloudCellsIntoNotebookViewStores([
      {
        id: "cell-code",
        cellType: "code",
        source: "print('painted')",
        language: "python",
        executionId: "exec-1",
        executionCount: 3,
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: "painted output\n",
            output_id: "out-1",
          },
        ],
        metadata: {},
      },
      {
        id: "cell-md",
        cellType: "markdown",
        source: "# Painted",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ] satisfies ResolvedCell[]);
  }

  function assertPainted(): void {
    assert.deepEqual(getCellIdsSnapshot(), ["cell-code", "cell-md"]);
    assert.equal(getCellExecutionId("cell-code"), "exec-1");
    assert.equal(getExecutionById("exec-1")?.execution_count, 3);
    assert.deepEqual(getExecutionById("exec-1")?.output_ids, ["out-1"]);
    const output = getOutputById("out-1");
    assert.equal(output?.output_type, "stream");
  }

  it("preserves cells, outputs, and execution pointers across a same-notebook re-run", () => {
    paintNotebook();
    assertPainted();

    const preserved = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: PAINTED,
      nextNotebookIdentity: PAINTED,
    });

    assert.equal(preserved, true);
    // The whole painted surface survives — not just the cell list. Wiping
    // the execution/output stores while keeping cells still flickers every
    // output and execution count (the dominant visual mass).
    assertPainted();
  });

  it("hands an instant paint to the live effect: survives the gate, replaced in place", () => {
    // Instant first paint lands before the live effect settles; the gate
    // must keep it (no full→empty→full flash), and the live
    // materialization then replaces the painted cells wholesale — through
    // the same projection, never via a clearing reset.
    paintNotebook();
    const preserved = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: PAINTED,
      nextNotebookIdentity: PAINTED,
    });
    assert.equal(preserved, true);
    assertPainted();

    projectCloudCellsIntoNotebookViewStores([
      {
        id: "cell-code",
        cellType: "code",
        source: "print('live')",
        language: "python",
        executionId: "exec-2",
        executionCount: 4,
        outputs: [
          { output_type: "stream", name: "stdout", text: "live output\n", output_id: "out-2" },
        ],
        metadata: {},
      },
    ] satisfies ResolvedCell[]);

    assert.deepEqual(getCellIdsSnapshot(), ["cell-code"]);
    assert.equal(getCellExecutionId("cell-code"), "exec-2");
    assert.equal(getOutputById("out-2")?.output_type, "stream");
    // The painted snapshot's stale cloud-owned ids were swept by the
    // replacement, not by a blanking reset.
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("clears every projected store on a real notebook switch", () => {
    paintNotebook();

    const preserved = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: PAINTED,
      nextNotebookIdentity: "id:nb-2",
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
    assert.equal(getCellExecutionId("cell-code"), null);
    assert.equal(getExecutionById("exec-1"), undefined);
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("fails closed when no painted identity was recorded", () => {
    paintNotebook();

    const preserved = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: null,
      nextNotebookIdentity: PAINTED,
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("does not preserve an empty projection", () => {
    const preserved = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: PAINTED,
      nextNotebookIdentity: PAINTED,
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
  });

  // Source pins for the session wiring that cannot run under node (the hook
  // imports the component-bearing notebook surface): the cleanup and the
  // next run's body must both route through the shared gate.
  describe("cloud-viewer-session wiring", () => {
    const sessionSource = readFileSync(
      new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
      "utf8",
    );

    it("clears real notebook switches in the next run's body, before connecting", () => {
      // The cleanup closes over its own run's config, so switch-clearing
      // can only happen here — and a cleared switch also drops the painted
      // identity AND the live/paint-origin race flags (a cleared stage has
      // no pixels for either flag to describe), so the next notebook's
      // instant paint is not gated on the previous notebook's history.
      assert.match(
        sessionSource,
        /const preservedAcrossRuns = resetCloudProjectionUnlessPreserved\(\{\s*paintedNotebookIdentity: paintedNotebookIdentityRef\.current,\s*nextNotebookIdentity: `id:\$\{config\.notebookId\}`,\s*\}\);\s*if \(!preservedAcrossRuns\) \{\s*paintedNotebookIdentityRef\.current = null;/,
      );
      assert.match(
        sessionSource,
        /if \(!preservedAcrossRuns\) \{[\s\S]*?liveMaterializedRef\.current = false;\s*paintOriginRef\.current = false;\s*\}/,
      );
    });

    it("gates the cleanup on the shared store gate with only the pool reset unconditional", () => {
      assert.match(
        sessionSource,
        /resetCloudProjectionUnlessPreserved\(\{\s*paintedNotebookIdentity: paintedNotebookIdentityRef\.current,\s*nextNotebookIdentity: `id:\$\{config\.notebookId\}`,\s*\}\);\s*resetPoolState\(\);/,
      );
    });

    it("tracks the painted notebook identity only when cells actually painted", () => {
      assert.match(
        sessionSource,
        /if \(resolvedCells\.length > 0\) \{\s*paintedNotebookIdentityRef\.current = `id:\$\{config\.notebookId\}`;\s*\}/,
      );
    });

    it("keeps an unconditional full clear on true unmount", () => {
      assert.match(
        sessionSource,
        /useEffect\(\s*\(\) => \(\) => \{\s*resetCloudViewStoreProjection\(\);\s*resetRuntimeState\(\);\s*resetRuntimeStoresProjection\(\);\s*\},\s*\[\],\s*\);/,
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
});
