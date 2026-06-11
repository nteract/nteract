import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import {
  CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC,
  CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
  CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
  cloudConnectionErrorAcceptsAccessDiagnostic,
} from "../viewer/connection-diagnostics";
import { CloudNotebookNotices, cloudNotebookHasNotices } from "../viewer/notices";

globalThis.React = React;

function authState(mode: CloudPrototypeAuthState["mode"]): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "anonymous" ? null : "token",
    user: mode === "anonymous" ? null : "user@example.test",
    oidcClaims: null,
    requestedScope: "viewer",
    problem: mode === "invalid" || mode === "oidc_expired" ? "auth problem" : null,
  };
}

test("cloud notebook notices render nothing for ready anonymous viewers", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      status: { kind: "ready", message: "Ready" },
    }),
    false,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.equal(html, "");
});

test("cloud notebook notices suppress stale empty status when cells are readable", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasReadableSnapshot: true,
      status: { kind: "empty", message: "This notebook room has no cells yet." },
    }),
    false,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasReadableSnapshot: true,
      status: { kind: "empty", message: "This notebook room has no cells yet." },
      onResetAuth: () => {},
    }),
  );

  assert.equal(html, "");
});

test("cloud notebook notices render auth and connection policy through the shared stack", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc_expired"),
      authRenewal: { kind: "failed", message: "refresh failed" },
      connectionError: "websocket failed",
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onSignInAgain: () => {},
    }),
  );

  assert.match(html, /data-slot="notebook-notice-stack"/);
  assert.match(html, /Auth needs attention/);
  assert.match(html, /Your browser sign-in needs renewal/);
  assert.match(html, /Sign-in refresh failed/);
  assert.match(html, /Live room needs attention/);
  assert.match(html, /Sign in again/);
  assert.doesNotMatch(html, /Reset to anonymous/);
});

test("cloud notebook notices trust a fresh app session over stale localStorage auth", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("oidc_expired"),
      authRenewal: { kind: "failed", message: "refresh failed" },
      connectionError: null,
      hasAppSession: true,
      status: { kind: "ready", message: "Ready" },
    }),
    false,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc_expired"),
      authRenewal: { kind: "failed", message: "refresh failed" },
      connectionError: null,
      hasAppSession: true,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onSignInAgain: () => {},
    }),
  );

  assert.equal(html, "");
});

test("cloud notebook notices distinguish sign-in and access diagnostics from socket failures", () => {
  const signInHtml = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onSignInAgain: () => {},
    }),
  );

  assert.match(signInHtml, /Sign in required/);
  assert.match(signInHtml, /Sign in again to open the live notebook room/);
  assert.match(signInHtml, /Sign in again/);
  assert.doesNotMatch(signInHtml, /Use anonymous/);
  assert.doesNotMatch(signInHtml, /Live room unavailable/);

  const noAccessHtml = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(noAccessHtml, /Notebook access needed/);
  assert.match(noAccessHtml, /does not have access to this notebook yet/);
  assert.doesNotMatch(noAccessHtml, /Live room unavailable/);
});

test("cloud notebook notices aggregate renderer-asset failures into one quiet line with retry", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      rendererAssetError: new Error("Failed to fetch renderer JS: 404"),
      status: { kind: "ready", message: "Ready" },
    }),
    true,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      rendererAssetError: new Error("Failed to fetch renderer JS: 404"),
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onRetryRendererAssets: () => {},
    }),
  );

  // Exactly ONE notice for the whole page — N failing output wells never
  // produce per-output notice spam (the provider state is module-level).
  assert.equal(html.match(/Output renderer unavailable/g)?.length, 1);
  assert.match(html, /Rich outputs are paused/);
  assert.match(html, /Retry/);
  // Asset health stays out of connection vocabulary: no connection notice,
  // no reconnecting line.
  assert.doesNotMatch(html, /Live room/);
  assert.doesNotMatch(html, /Reconnecting/);
});

test("cloud notebook notices render nothing extra when renderer assets are healthy", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      rendererAssetError: null,
      status: { kind: "ready", message: "Ready" },
    }),
    false,
  );
});

test("terminal wasm-asset failures get a dedicated notice with a non-destructive Retry", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError:
        "runtimed WASM asset failed: Failed to fetch runtimed WASM (404): https://wasm.example/assets/runtimed_wasm_bg.0123456789abcdef.wasm",
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onRetryConnection: () => {},
      onSignInAgain: () => {},
    }),
  );

  assert.match(html, /Notebook engine failed to load/);
  assert.match(html, /Retry/);
  // Auth actions cannot remedy an asset 404 — and "Use anonymous" would
  // destroy a signed-in session.
  assert.doesNotMatch(html, /Use anonymous/);
  assert.doesNotMatch(html, /Sign in again/);
  assert.doesNotMatch(html, /Live room needs attention/);
});

test("a resolved access diagnostic never overwrites the wasm-failure Retry notice", () => {
  // The session applies an access diagnostic only when the guard allows it;
  // a terminal asset failure refuses, so the connection error — and the
  // notice rendered from it — keeps the WASM-failure Retry shape.
  const assetFailure =
    "runtimed WASM asset failed: Failed to fetch runtimed WASM (404): https://wasm.example/assets/runtimed_wasm_bg.wasm";
  const connectionError = cloudConnectionErrorAcceptsAccessDiagnostic(assetFailure)
    ? CLOUD_CONNECTION_EDIT_ACCESS_PENDING_DIAGNOSTIC
    : assetFailure;

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onRetryConnection: () => {},
      onSignInAgain: () => {},
    }),
  );

  assert.match(html, /Notebook engine failed to load/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Edit access pending/);
});

test("wasm-asset failures show no action when no retry callback is wired", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: "runtimed WASM asset failed: Failed to fetch dynamically imported module",
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Notebook engine failed to load/);
  // The prototype-era "Use anonymous" fallback is gone: no destructive CTA.
  assert.doesNotMatch(html, /Use anonymous/);
});

test("connection notice sanitizer redacts http(s) URLs down to host and path", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError:
        "runtimed WASM asset failed: Failed to fetch runtimed WASM (403): https://cdn.example/assets/runtimed_wasm_bg.wasm?token=SECRET#frag",
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
      onRetryConnection: () => {},
    }),
  );

  assert.match(html, /https:\/\/cdn\.example\/assets\/runtimed_wasm_bg\.wasm/);
  assert.doesNotMatch(html, /SECRET/);
  assert.doesNotMatch(html, /token=/);
});

test("cloud notebook notices keep dev diagnostics inside the shared stack", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("anonymous"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      status: { kind: "ready", message: "Ready" },
      diagnostics: React.createElement("div", { "data-kind": "diagnostics" }, "diagnostics"),
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /data-slot="notebook-notice-stack"/);
  assert.match(html, /data-kind="diagnostics"/);
});

// ── Offline-merge surfacing (local-first ADR, PR 5) ────────────────────

import { offlineMergeNoticeTitle, offlineMergeRemovedCellsLine } from "../viewer/notices";

test("offline merge notice copy drops the suffix when the count is unknown or zero", () => {
  assert.equal(
    offlineMergeNoticeTitle({ mergedRemoteCellCount: null, removedEditedCellCount: 0 }),
    "Synced your offline edits.",
  );
  assert.equal(
    offlineMergeNoticeTitle({ mergedRemoteCellCount: 0, removedEditedCellCount: 0 }),
    "Synced your offline edits.",
  );
  assert.equal(
    offlineMergeNoticeTitle({ mergedRemoteCellCount: 1, removedEditedCellCount: 0 }),
    "Synced your offline edits — 1 update from collaborators merged.",
  );
  assert.equal(
    offlineMergeNoticeTitle({ mergedRemoteCellCount: 3, removedEditedCellCount: 0 }),
    "Synced your offline edits — 3 updates from collaborators merged.",
  );
});

test("offline merge removed-cells line appears only for a real removal", () => {
  assert.equal(offlineMergeRemovedCellsLine(0), null);
  assert.equal(
    offlineMergeRemovedCellsLine(1),
    "A cell you edited offline was removed by a collaborator.",
  );
  assert.equal(
    offlineMergeRemovedCellsLine(2),
    "2 cells you edited offline were removed by a collaborator.",
  );
});

test("cloud notebook notices render the offline merge line as one quiet info notice", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      offlineMergeNotice: { mergedRemoteCellCount: 2, removedEditedCellCount: 1 },
      status: { kind: "ready", message: "Ready" },
    }),
    true,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      offlineMergeNotice: { mergedRemoteCellCount: 2, removedEditedCellCount: 1 },
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /data-slot="notebook-notice-stack"/);
  assert.match(html, /data-tone="info"/);
  assert.match(html, /Synced your offline edits — 2 updates from collaborators merged\./);
  assert.match(html, /A cell you edited offline was removed by a collaborator\./);
  // One quiet notice, no modal-ish chrome: no actions and no error tone.
  assert.doesNotMatch(html, /data-tone="error"/);
  assert.doesNotMatch(html, /data-tone="warning"/);
});

test("offline merge notice omits the removed-cells line when nothing vanished", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      offlineMergeNotice: { mergedRemoteCellCount: null, removedEditedCellCount: 0 },
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Synced your offline edits\./);
  assert.doesNotMatch(html, /from collaborators merged/);
  assert.doesNotMatch(html, /removed by a collaborator/);
});

test("offline merge notice stacks with (and does not disturb) the reconnect line", () => {
  // In practice they are sequential — the sustained line clears the moment
  // the room is back, exactly when the merge notice can first appear — but
  // the stack must keep both legible if state ever overlaps mid-render.
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      offlineMergeNotice: { mergedRemoteCellCount: 0, removedEditedCellCount: 0 },
      sustainedReconnecting: true,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Reconnecting\./);
  assert.match(html, /Your edits are kept locally/);
  assert.match(html, /Synced your offline edits\./);
});

test("no offline merge notice means no offline merge markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      offlineMergeNotice: null,
      sustainedReconnecting: true,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Reconnecting\./);
  assert.doesNotMatch(html, /Synced your offline edits/);
});

test("sync-heal exhaustion renders ONE calm stalled line and counts as a notice", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      syncHealStalled: true,
      status: { kind: "ready", message: "Ready" },
    }),
    true,
  );

  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      syncHealStalled: true,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Sync is stalled\./);
  assert.match(html, /Your edits are kept locally\./);
  // Quiet rules: one occurrence, info tone, never a modal or action.
  assert.equal(html.match(/Sync is stalled\./g)?.length, 1);
});

test("the sustained-reconnecting line owns the surface while the link is down", () => {
  // The heal loop does not even re-kick while the transport is
  // reconnecting, and two "edits are kept locally" lines would be noise:
  // the stalled line yields to the reconnect line.
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      sustainedReconnecting: true,
      syncHealStalled: true,
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /Reconnecting\./);
  assert.doesNotMatch(html, /Sync is stalled\./);
});

test("a cleared stall renders nothing (late convergence clears the line)", () => {
  assert.equal(
    cloudNotebookHasNotices({
      authState: authState("oidc"),
      authRenewal: { kind: "idle", message: null },
      connectionError: null,
      hasAppSession: true,
      syncHealStalled: false,
      status: { kind: "ready", message: "Ready" },
    }),
    false,
  );
});
