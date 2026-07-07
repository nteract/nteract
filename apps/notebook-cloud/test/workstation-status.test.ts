import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workstationStatusForResponse } from "../src/index.ts";
import type { WorkstationRow } from "../src/storage.ts";
import type { WorkstationLeaseRecord } from "../src/compute-session-index.ts";

const NOW = 1_780_000_000_000;

function row(overrides: Partial<WorkstationRow> = {}): WorkstationRow {
  return {
    status: "online",
    last_seen_at: new Date(NOW).toISOString(),
    ...overrides,
  } as WorkstationRow;
}

function lease(overrides: Partial<WorkstationLeaseRecord> = {}): WorkstationLeaseRecord {
  return {
    workstation_id: "ws-a",
    owner_principal: "user:dev:alice",
    last_seen_at: new Date(NOW).toISOString(),
    lease_expires_at: NOW + 60_000,
    online: true,
    offline_reason: null,
    ...overrides,
  };
}

describe("workstationStatusForResponse", () => {
  it("reports online from a live lease", () => {
    assert.equal(workstationStatusForResponse(row(), NOW, null, lease()), "online");
  });

  it("reports offline from a lease the alarm swept", () => {
    const swept = lease({ online: false, offline_reason: "lease expired" });
    assert.equal(workstationStatusForResponse(row(), NOW, null, swept), "offline");
  });

  it("reports offline from a lapsed lease even if the alarm was late to flip online", () => {
    // online === true but the window already passed: a late alarm must not
    // read as live.
    const lapsed = lease({ online: true, lease_expires_at: NOW - 1 });
    assert.equal(workstationStatusForResponse(row(), NOW, null, lapsed), "offline");
  });

  it("falls back to lazy D1 staleness when no lease exists", () => {
    const fresh = row({ last_seen_at: new Date(NOW).toISOString() });
    assert.equal(workstationStatusForResponse(fresh, NOW, null, null), "online");

    const stale = row({ last_seen_at: new Date(NOW - 4 * 60_000).toISOString() });
    assert.equal(workstationStatusForResponse(stale, NOW, null, null), "offline");
  });

  it("lets a live event socket override a swept lease", () => {
    const swept = lease({ online: false });
    assert.equal(
      workstationStatusForResponse(row(), NOW, { connected: true, connections: 1 }, swept),
      "online",
    );
  });

  it("ignores a stale offline lease when the D1 row is fresher", () => {
    // Heartbeat landed in D1 but the paired lease write lagged or failed, so the
    // lease still reads the pre-heartbeat swept-offline verdict. D1 is the newer
    // signal; a fresh row must not be regressed to offline.
    const freshRow = row({ last_seen_at: new Date(NOW).toISOString() });
    const staleSwept = lease({
      online: false,
      last_seen_at: new Date(NOW - 5 * 60_000).toISOString(),
    });
    assert.equal(workstationStatusForResponse(freshRow, NOW, null, staleSwept), "online");
  });
});
