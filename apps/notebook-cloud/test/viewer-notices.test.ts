import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import { CloudNotebookNotices } from "../viewer/notices";

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

test("cloud notebook notices render auth and connection policy through the shared stack", () => {
  const html = renderToStaticMarkup(
    React.createElement(CloudNotebookNotices, {
      authState: authState("oidc_expired"),
      authRenewal: { kind: "failed", message: "refresh failed" },
      connectionError: "websocket failed",
      status: { kind: "ready", message: "Ready" },
      onResetAuth: () => {},
    }),
  );

  assert.match(html, /data-slot="notebook-notice-stack"/);
  assert.match(html, /Auth needs attention/);
  assert.match(html, /Sign-in refresh failed/);
  assert.match(html, /Live room connection failed/);
  assert.match(html, /Reset to anonymous/);
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
