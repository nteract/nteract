import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CloudflareWebSocket, DurableObjectState } from "../src/cloudflare-types.ts";
import { webSocketDisconnectFields } from "../src/websocket-lifecycle.ts";

describe("WebSocket disconnect diagnostics", () => {
  const socket = {} as CloudflareWebSocket;
  for (const capability of ["missing", "never", "released", "invalid"] as const) {
    it(`keeps cleanup usable when heartbeat timestamps are ${capability}`, () => {
      const state = {} as DurableObjectState;
      if (capability !== "missing")
        state.getWebSocketAutoResponseTimestamp = () => {
          if (capability === "released") throw new Error("socket no longer registered");
          return capability === "invalid" ? new Date(Number.NaN) : null;
        };
      const fields = webSocketDisconnectFields(
        state,
        socket,
        { source: "room", code: 1008, reason: "access revoked" },
        "invalid date",
      );
      assert.equal(fields.last_auto_response_at, null);
      assert.equal(fields.auto_response_timestamp_supported, capability !== "missing");
      assert.equal(fields.connection_duration_ms, undefined);
      assert.equal(fields.close_source, "room");
      assert.equal(fields.close_code, 1008);
      assert.equal(fields.close_reason, "access revoked");
      assert.equal(
        fields.close_was_clean,
        undefined,
        "requested close is not an observed handshake",
      );
    });
  }

  it("bounds runtime error and peer-provided close text", () => {
    const state = {} as DurableObjectState;
    assert.equal(
      String(
        webSocketDisconnectFields(
          state,
          socket,
          { source: "websocket_error", error: new Error("e".repeat(1000)) },
          "",
        ).close_error,
      ).length,
      512,
    );
    assert.equal(
      String(
        webSocketDisconnectFields(
          state,
          socket,
          { source: "websocket_close", reason: "r".repeat(1000), wasClean: false },
          "",
        ).close_reason,
      ).length,
      256,
    );
  });

  it("keeps cleanup usable for an error without a string representation", () => {
    const fields = webSocketDisconnectFields(
      {} as DurableObjectState,
      socket,
      { source: "websocket_error", error: Object.create(null) },
      "",
    );
    assert.equal(fields.close_error, "unprintable WebSocket error");
  });
});
