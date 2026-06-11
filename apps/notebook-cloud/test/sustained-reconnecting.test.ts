import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import { CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC } from "../viewer/connection-diagnostics";
import {
  CloudNotebookNotices,
  cloudNotebookHasNotices,
  isTransportReconnectError,
} from "../viewer/notices";
import { SustainedReconnectingTracker } from "../viewer/use-sustained-reconnecting";

globalThis.React = React;

// Field report: a moderate offline window produced zero UI change. The slot
// dot is 8px by design, so legibility comes from ONE debounced notices-stack
// line — present only while "reconnecting" outlives the debounce, cleared the
// moment the room is back, and silent across sub-debounce flaps.
describe("sustained reconnecting tracker", () => {
  function tracked() {
    const changes: boolean[] = [];
    const tracker = new SustainedReconnectingTracker({
      debounceMs: 3_000,
      onChange: (sustained) => changes.push(sustained),
    });
    return { changes, tracker };
  }

  it("flips true only after reconnecting persists past the debounce", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    tracker.next("reconnecting");
    t.mock.timers.tick(2_999);
    assert.deepEqual(changes, [] as boolean[], "no line inside the debounce window");
    t.mock.timers.tick(1);
    assert.deepEqual(changes, [true]);
    tracker.dispose();
  });

  it("clears on online", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    tracker.next("reconnecting");
    t.mock.timers.tick(3_000);
    tracker.next("online");
    assert.deepEqual(changes, [true, false]);
    tracker.dispose();
  });

  it("stays silent across sub-debounce flaps", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    for (let i = 0; i < 5; i += 1) {
      tracker.next("reconnecting");
      t.mock.timers.tick(1_000);
      tracker.next("online");
      t.mock.timers.tick(1_000);
    }
    // The recovered windows must not accumulate into a phantom line.
    t.mock.timers.tick(60_000);
    assert.deepEqual(changes, [] as boolean[]);
    tracker.dispose();
  });

  it("fires once per outage no matter how many reconnecting deliveries arrive", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    tracker.next("reconnecting");
    t.mock.timers.tick(1_000);
    tracker.next("reconnecting"); // re-delivery while armed: no re-arm
    t.mock.timers.tick(2_000);
    assert.deepEqual(changes, [true], "the ORIGINAL deadline holds");
    tracker.next("reconnecting"); // while sustained: no-op
    t.mock.timers.tick(10_000);
    assert.deepEqual(changes, [true]);
    tracker.dispose();
  });

  it("treats a replacement transport's connecting as neutral", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    // connecting never arms: initial connect is not an outage.
    tracker.next("connecting");
    t.mock.timers.tick(60_000);
    assert.deepEqual(changes, [] as boolean[]);

    // And it never clears: a session-level retry creates a fresh transport
    // that reports "connecting" before its first handshake — the room is
    // still down, so the line stays until online.
    tracker.next("reconnecting");
    t.mock.timers.tick(3_000);
    tracker.next("connecting");
    assert.deepEqual(changes, [true]);
    tracker.next("online");
    assert.deepEqual(changes, [true, false]);
    tracker.dispose();
  });

  it("clears on terminal offline and cancels on dispose", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { changes, tracker } = tracked();

    tracker.next("reconnecting");
    t.mock.timers.tick(3_000);
    tracker.next("offline"); // manual disconnect: 'Reconnecting' would lie
    assert.deepEqual(changes, [true, false]);

    tracker.next("reconnecting");
    tracker.dispose(); // unmount mid-debounce
    t.mock.timers.tick(60_000);
    assert.deepEqual(changes, [true, false]);
  });
});

describe("sustained reconnecting notice", () => {
  const anonymousAuth: CloudPrototypeAuthState = {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: "viewer",
    problem: null,
  };

  function renderNotices(
    overrides: Partial<React.ComponentProps<typeof CloudNotebookNotices>>,
  ): string {
    return renderToStaticMarkup(
      React.createElement(CloudNotebookNotices, {
        authState: anonymousAuth,
        authRenewal: { kind: "idle", message: null },
        connectionError: null,
        hasReadableSnapshot: true,
        status: { kind: "ready", message: "Ready" },
        onResetAuth: () => {},
        ...overrides,
      }),
    );
  }

  it("classifies exactly the transport's own link-loss shapes", () => {
    // The calm-reconnect funnel: link-level losses the retry loop owns.
    assert.equal(isTransportReconnectError("browser reported offline"), true);
    assert.equal(isTransportReconnectError("cloud sync socket closed (1006)"), true);
    assert.equal(
      isTransportReconnectError("cloud sync socket closed (1008): too many rejected frames"),
      true,
    );
    assert.equal(isTransportReconnectError("cloud sync socket failed"), true);
    assert.equal(
      isTransportReconnectError("cloud sync socket send failed: socket is closing"),
      true,
    );
    assert.equal(
      isTransportReconnectError("cloud sync liveness ping failed: synthetic send failure"),
      true,
    );
    assert.equal(
      isTransportReconnectError("cloud sync liveness pong missed (no reply within 10000ms)"),
      true,
    );
    assert.equal(
      isTransportReconnectError("cloud room handshake did not complete within 30000ms"),
      true,
    );
  });

  it("keeps terminal-looking failures on the actionable diagnostic route", () => {
    // The transport wraps NON-link failures in similar prefixes; a broad
    // prefix match routed mid-session terminal auth/access failures into
    // the perpetual calm "Reconnecting." line with no CTA. These must keep
    // the warning notice.
    assert.equal(
      isTransportReconnectError("cloud sync connect target failed: Unable to read app session"),
      false,
    );
    assert.equal(
      isTransportReconnectError("cloud sync socket creation failed: invalid URL"),
      false,
    );
    assert.equal(
      isTransportReconnectError("cloud sync socket message failed: unexpected token"),
      false,
    );
    assert.equal(
      isTransportReconnectError("cloud room rejected frame: notebook sync rejected"),
      false,
    );
    assert.equal(isTransportReconnectError(CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC), false);
    assert.equal(isTransportReconnectError("websocket failed"), false);
  });

  it("renders the actionable warning for non-link transport failures", () => {
    const html = renderNotices({
      connectionError: "cloud sync connect target failed: Unable to read app session",
    });
    assert.match(html, /Live room needs attention/);
    assert.match(html, /cloud sync connect target failed/);
    assert.match(html, /Use anonymous/, "the warning keeps its action");
    assert.doesNotMatch(html, /Your edits are kept locally/);

    const rejectionHtml = renderNotices({
      connectionError: "cloud room rejected frame: notebook sync rejected",
    });
    assert.match(rejectionHtml, /Live room needs attention/);
  });

  it("shows the single quiet line while reconnecting is sustained", () => {
    const html = renderNotices({
      sustainedReconnecting: true,
      connectionError: "cloud sync socket closed (1006)",
    });
    assert.match(html, /Reconnecting\./);
    assert.match(html, /Your edits are kept locally and will sync when the connection returns\./);
    assert.doesNotMatch(html, /Live room needs attention/);
    assert.doesNotMatch(html, /cloud sync socket closed/);
    assert.equal(
      (html.match(/data-slot="notebook-notice"/g) ?? []).length,
      1,
      "one line, not a reconnect line plus a per-drop warning",
    );
  });

  it("surfaces nothing for a transport drop inside the debounce window", () => {
    for (const error of [
      "cloud sync socket closed (1006)",
      "browser reported offline",
      "cloud room handshake did not complete within 30000ms",
    ]) {
      assert.equal(
        cloudNotebookHasNotices({
          authState: anonymousAuth,
          authRenewal: { kind: "idle", message: null },
          connectionError: error,
          hasReadableSnapshot: true,
          status: { kind: "ready", message: "Ready" },
        }),
        false,
        `${error} must wait for the sustained flag`,
      );
      assert.equal(renderNotices({ connectionError: error }), "");
    }
  });

  it("clears the line when sustained reconnecting ends", () => {
    assert.equal(renderNotices({ sustainedReconnecting: false }), "");
    assert.equal(
      cloudNotebookHasNotices({
        authState: anonymousAuth,
        authRenewal: { kind: "idle", message: null },
        connectionError: null,
        hasReadableSnapshot: true,
        status: { kind: "ready", message: "Ready" },
        sustainedReconnecting: false,
      }),
      false,
    );
  });

  it("keeps access diagnostics as their own immediate notice", () => {
    const html = renderNotices({ connectionError: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC });
    assert.match(html, /Notebook access needed/);
  });
});

test("notebook viewer wires the debounced status line into the notices stack", () => {
  const viewerSource = readFileSync(
    new URL("../viewer/notebook-viewer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    viewerSource,
    /const sustainedReconnecting = useSustainedReconnecting\(connectionStatus\$\);/,
  );
  assert.match(viewerSource, /sustainedReconnecting=\{sustainedReconnecting\}/);
  assert.match(viewerSource, /sustainedReconnecting,\n/);
});
