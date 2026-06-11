import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldPreserveBootstrapProjection } from "../../notebook/src/lib/bootstrap-preservation.ts";

// Field-observed flicker: with IndexedDB seeding, the persisted snapshot
// paints cells well before the live-room effect settles. The effect re-runs
// for reasons that are NOT a notebook switch (the mount-time session-status
// fetch replacing the session object identity), and its cleanup used to clear
// the projection unconditionally — full notebook → one empty frame → full
// notebook. The cleanup now reuses the desktop bootstrap-preservation gate:
// same painted notebook with visible cells is preserved; a real notebook
// switch or a never-painted projection still clears.
describe("cloud projection flicker gate", () => {
  const cloudIdentity = (notebookId: string) => `id:${notebookId}`;

  it("preserves a painted projection when the SAME notebook reconnects", () => {
    assert.equal(
      shouldPreserveBootstrapProjection({
        previousIdentity: cloudIdentity("nb-1"),
        nextIdentity: cloudIdentity("nb-1"),
        visibleCellCount: 4,
      }),
      true,
    );
  });

  it("clears when the effect re-run targets a DIFFERENT notebook", () => {
    assert.equal(
      shouldPreserveBootstrapProjection({
        previousIdentity: cloudIdentity("nb-1"),
        nextIdentity: cloudIdentity("nb-2"),
        visibleCellCount: 4,
      }),
      false,
    );
  });

  it("clears when nothing was ever painted", () => {
    assert.equal(
      shouldPreserveBootstrapProjection({
        previousIdentity: null,
        nextIdentity: cloudIdentity("nb-1"),
        visibleCellCount: 0,
      }),
      false,
    );
  });

  it("clears when the painted projection has no visible cells", () => {
    assert.equal(
      shouldPreserveBootstrapProjection({
        previousIdentity: cloudIdentity("nb-1"),
        nextIdentity: cloudIdentity("nb-1"),
        visibleCellCount: 0,
      }),
      false,
    );
  });

  // Source guardrails: pin the session wiring that composes the gate, so a
  // refactor cannot silently reintroduce the unconditional cleanup clear.
  describe("cloud-viewer-session wiring", () => {
    const sessionSource = readFileSync(
      new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
      "utf8",
    );

    it("gates the live-effect cleanup clear on bootstrap preservation", () => {
      assert.match(
        sessionSource,
        /const preserveProjection = shouldPreserveBootstrapProjection\(\{\s*previousIdentity: paintedNotebookIdentityRef\.current,\s*nextIdentity: `id:\$\{config\.notebookId\}`,\s*visibleCellCount: getCellIdsSnapshot\(\)\.length,\s*\}\);\s*if \(!preserveProjection\) \{\s*resetCloudViewStoreProjection\(\);\s*\}/,
      );
    });

    it("tracks the painted notebook identity only when cells actually painted", () => {
      assert.match(
        sessionSource,
        /if \(resolvedCells\.length > 0\) \{\s*paintedNotebookIdentityRef\.current = `id:\$\{config\.notebookId\}`;\s*\}/,
      );
    });

    it("keeps the unconditional unmount-scoped projection clear", () => {
      assert.match(sessionSource, /useEffect\(\(\) => resetCloudViewStoreProjection, \[\]\);/);
    });

    it("shares the desktop bootstrap-preservation helper through the public surface", () => {
      const surfaceImport = sessionSource.match(
        /import \{[\s\S]*?\} from "\.\.\/\.\.\/notebook\/src\/notebook-surface";/,
      );
      assert.ok(surfaceImport, "expected a notebook-surface import");
      assert.match(surfaceImport[0], /\bshouldPreserveBootstrapProjection\b/);
      assert.doesNotMatch(
        sessionSource,
        /notebook\/src\/lib\/bootstrap-preservation/,
        "viewer must import the helper via notebook-surface, not desktop internals",
      );
    });
  });
});
