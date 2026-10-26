import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { runColdSync } from "./persistence-cold-sync-repro.mjs";

let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

// Native0.23 drops uncovered ancestors when fragments are present. These exact
// deterministic histories also qualify Repo.find readiness, separately from the
// byte-store codec and cleanup. Do not seed peers or inject omitted records here.
for (const kind of ["prose", "counter"]) {
  for (const includeFragments of [false, true]) {
    test(
      `cold ${kind} peer loads exact history ${includeFragments ? "with" : "without"} fragments`,
      { timeout: 15_000 },
      async () => {
        const result = await runColdSync({ kind, includeFragments });
        assert.equal(result.loaded, true, JSON.stringify(result.loadError));
        assert.deepEqual(result.missingChanges, []);
        assert.deepEqual(result.missingDependencies, []);
        assert.deepEqual(result.receivedHeads, result.fixtureHeads);
        assert.equal(result.loadedAfterExplicitRound, true);
        assert.equal(result.supplyingMissingLooseChangesRestoresExactIdentity, undefined);
      },
    );
  }
}
