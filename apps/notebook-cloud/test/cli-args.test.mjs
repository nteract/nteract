import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstPositionalArg } from "../scripts/cli-args.mjs";

describe("notebook-cloud smoke CLI args", () => {
  it("returns the first positional argument", () => {
    assert.equal(
      firstPositionalArg(["https://preview.runt.run/n/id/name"]),
      "https://preview.runt.run/n/id/name",
    );
  });

  it("ignores npm/pnpm separator arguments before the URL", () => {
    assert.equal(
      firstPositionalArg(["--", "https://preview.runt.run/n/topic-viz/topic-viz"]),
      "https://preview.runt.run/n/topic-viz/topic-viz",
    );
  });

  it("ignores empty arguments", () => {
    assert.equal(
      firstPositionalArg(["", "--", "  ", "https://preview.runt.run/n/id/name"]),
      "https://preview.runt.run/n/id/name",
    );
  });

  it("returns undefined when no positional argument is present", () => {
    assert.equal(firstPositionalArg([]), undefined);
    assert.equal(firstPositionalArg(["--", ""]), undefined);
  });
});
