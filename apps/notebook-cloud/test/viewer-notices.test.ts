import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import {
  CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC,
  CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC,
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
