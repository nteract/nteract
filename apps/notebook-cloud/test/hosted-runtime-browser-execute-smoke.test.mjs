import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertBrowserRunAdvanced,
  browserRunSummary,
  parseJsonOutput,
  parseScopes,
} from "../scripts/hosted-runtime-browser-execute-smoke.mjs";

describe("hosted runtime/browser execute smoke helpers", () => {
  it("parses default and explicit browser scopes", () => {
    assert.deepEqual(parseScopes(undefined), ["owner"]);
    assert.deepEqual(parseScopes("owner,editor"), ["owner", "editor"]);
    assert.deepEqual(parseScopes("owner editor"), ["owner", "editor"]);
    assert.deepEqual(parseScopes(" owner "), ["owner"]);
  });

  it("rejects unsupported scopes", () => {
    assert.throws(() => parseScopes("viewer"), /owner or editor/);
    assert.throws(() => parseScopes("owner,viewer"), /owner or editor/);
  });

  it("extracts JSON from child stdout with surrounding logs", () => {
    assert.deepEqual(parseJsonOutput('{"ok":true}', "child"), { ok: true });
    assert.deepEqual(parseJsonOutput('log before\n{"ok":true,"value":7}\nlog after', "child"), {
      ok: true,
      value: 7,
    });
  });

  it("throws on child stdout without parseable JSON", () => {
    assert.throws(() => parseJsonOutput("not json", "child"), /parseable JSON/);
  });

  it("summarizes browser execute results for reports", () => {
    assert.deepEqual(
      browserRunSummary(
        {
          click: {
            clickedAria: "Run cell",
            afterAria: "Run cell again; last execution 2",
            beforeExecutionOrdinal: 1,
            afterExecutionOrdinal: 2,
          },
          checks: ["execute_button_clicked"],
        },
        "owner",
      ),
      {
        scope: "owner",
        clickedAria: "Run cell",
        afterAria: "Run cell again; last execution 2",
        beforeExecutionOrdinal: 1,
        afterExecutionOrdinal: 2,
        checks: ["execute_button_clicked"],
      },
    );
  });

  it("requires browser execution to advance past the seeded runtime-peer run", () => {
    assert.doesNotThrow(() =>
      assertBrowserRunAdvanced({
        scope: "owner",
        afterExecutionOrdinal: 2,
      }),
    );
    assert.throws(
      () =>
        assertBrowserRunAdvanced({
          scope: "editor",
          afterExecutionOrdinal: 1,
        }),
      /did not advance/,
    );
  });
});
