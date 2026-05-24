import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { structuredCloudLog } from "../src/observability.ts";

describe("notebook-cloud observability", () => {
  it("emits structured log records with stable event and counter fields", () => {
    const record = structuredCloudLog("room.frame.rejected", {
      notebook_id: "demo",
      peer_id: "peer-a",
      scope: "viewer",
      frame_type: "automerge_sync",
      counter: "rejected_frames",
      counter_delta: 1,
    });

    assert.equal(record.service, "nteract-notebook-cloud");
    assert.equal(record.event, "room.frame.rejected");
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.notebook_id, "demo");
    assert.equal(record.counter, "rejected_frames");
    assert.equal(record.counter_delta, 1);
  });

  it("omits undefined fields so log-derived counters stay sparse", () => {
    const record = structuredCloudLog("render.materialization.completed", {
      notebook_id: "demo",
      runtime_heads_hash: undefined,
      counter: "render_materializations",
      counter_delta: 1,
    });

    assert.equal("runtime_heads_hash" in record, false);
    assert.equal(record.counter, "render_materializations");
  });
});
