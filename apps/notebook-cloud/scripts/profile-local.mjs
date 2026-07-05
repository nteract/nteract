import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import { notebookCloudBaseUrl } from "./local-dev.mjs";

// Local-wrangler profiling harness for the cloud viewer. Given NTERACT_CLOUD_URL
// (falling back to the per-worktree wrangler port), it visits /n and
// /workstations cold and records, per route: cloud viewer performance marks,
// navigation timing, a long-task total (TBT proxy) across load + a settle
// window, event-timing for one scripted interaction (INP proxy), JS transfer
// bytes from network events, opened WebSockets, and React commit counts from
// the ?profile=1 render hook. It then runs a reconnect-stability check on a
// freshly created notebook room (loopback dev auth), or on /n when a room
// cannot be created. One JSON report goes to stdout; a human table to stderr.
//
// A property that could not be measured is reported as unavailable, never as a
// clean zero: a detached long-task observer yields tbtProxyMs null, an
// interaction that never landed yields inpProxyMs null, and the reconnect check
// asserts its own stability. A failed reconnect assertion (a new WebSocket or a
// document reload) fails the process with a non-zero exit.
//
// Litter: each run creates one reconnect probe notebook and the worker exposes
// no notebook-delete endpoint, so probes accumulate. Their titles carry an
// ISO-8601 timestamp prefix so an operator can find and sweep them by age.
//
// Auth is loopback dev-token only. The worker trusts these localStorage keys and
// the matching x-notebook-cloud-dev-token header on loopback hosts when started
// with NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS:true (scripts/dev.mjs sets it). The
// three storage keys mirror src/dev-auth-storage.ts and the header mirrors
// src/auth-shared.ts DEV_AUTH_TOKEN_HEADER; those files are the source of truth.
const DEV_TOKEN = "local-loopback-dev-token";
const DEV_USER = "browser-editor";
const DEV_SCOPE = "owner";
const DEV_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:dev-token";
const DEV_USER_STORAGE_KEY = "nteract:notebook-cloud:user";
const DEV_SCOPE_STORAGE_KEY = "nteract:notebook-cloud:scope";
const DEV_TOKEN_HEADER = "x-notebook-cloud-dev-token";

// Renewal check. Active only when the dev OIDC issuer is mounted (scripts/dev.mjs
// default). The issuer path and the storage key mirror src/dev-oidc.ts and
// viewer/oidc-auth.ts; those files are the source of truth.
const LOCAL_OIDC_MOUNT_PATH = "/dev/oidc";
const LOCAL_OIDC_CLIENT_ID = "local-oidc-client";
const LOCAL_OIDC_SCOPE = "openid email profile offline_access";
const OIDC_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:oidc-token";
const RENEWAL_SETTLE_MS = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_PROFILE_RENEWAL_SETTLE_MS,
  4_000,
);

const SETTLE_MS = parsePositiveInteger(process.env.NOTEBOOK_CLOUD_PROFILE_SETTLE_MS, 10_000);
const NOTEBOOK_SETTLE_MS = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_PROFILE_NOTEBOOK_SETTLE_MS,
  4_000,
);
const NAV_TIMEOUT_MS = parsePositiveInteger(process.env.NOTEBOOK_CLOUD_PROFILE_TIMEOUT_MS, 45_000);
const READY_TIMEOUT_MS = 15_000;

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const baseUrl = notebookCloudBaseUrl();
  const origin = new URL(baseUrl).origin;
  logStderr(`Profiling cloud viewer at ${baseUrl}`);

  await waitForWorkerReady(baseUrl);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(profileInitScript, {
    devTokenKey: DEV_TOKEN_STORAGE_KEY,
    devToken: DEV_TOKEN,
    userKey: DEV_USER_STORAGE_KEY,
    user: DEV_USER,
    scopeKey: DEV_SCOPE_STORAGE_KEY,
    scope: DEV_SCOPE,
  });
  await context.addInitScript(visibilityOverrideInitScript);

  const limitations = [];
  let created = null;
  try {
    created = await createLoopbackNotebook(context, baseUrl, origin);
    logStderr(`Created probe notebook ${created.notebookId}`);
  } catch (error) {
    limitations.push(
      `loopback notebook creation failed (${errorText(error)}); reconnect check ran on /n instead`,
    );
    logStderr(`Notebook creation failed: ${errorText(error)}`);
  }

  const routes = {};
  try {
    routes["/n"] = await profileRoute(context, {
      baseUrl,
      routePath: "/n",
      label: "notebook-list",
      settleMs: SETTLE_MS,
      readySelector: 'main.nb-app, [data-kind="error"]',
      interactionCandidates: [
        { label: "refresh-notebooks", selector: 'button[aria-label="Refresh notebooks"]' },
        { label: "new-notebook", selector: 'button:has-text("New notebook")' },
      ],
    });
    routes["/workstations"] = await profileRoute(context, {
      baseUrl,
      routePath: "/workstations",
      label: "workstations",
      settleMs: SETTLE_MS,
      readySelector: 'main.nb-app, [data-kind="error"]',
      interactionCandidates: [
        { label: "workstation-row", selector: "[data-workstation-id]" },
        { label: "refresh-workstations", selector: 'button[aria-label="Refresh workstations"]' },
      ],
    });

    const notebook = created
      ? await profileNotebookReconnect(context, { origin, created })
      : await profileListReconnect(context, { baseUrl });

    const renewal = await profileOidcRenewal(browser, { baseUrl, origin, limitations });

    // A ?profile=1 load creates window.__nteractRenderCounts eagerly, so an
    // empty object across every surface means the Profiler mounted but onRender
    // never fired: the standard production react-dom build makes Profiler timing
    // inert. Rebuild with NOTEBOOK_CLOUD_PROFILE_REACT=1 to record real counts.
    const sawRenderCounts = [
      ...Object.values(routes).map((route) => route.renderCounts),
      notebook.renderCounts,
    ].some((counts) => counts && Object.keys(counts).length > 0);
    if (!sawRenderCounts) {
      limitations.push(
        "render counts empty: React <Profiler> onRender is inert in the default production build; rebuild with NOTEBOOK_CLOUD_PROFILE_REACT=1 pnpm build:viewer for real counts",
      );
    }

    const reconnect = notebook.reconnect;
    const report = {
      ok: reconnect.stable,
      baseUrl,
      settleMs: SETTLE_MS,
      generatedAt: new Date().toISOString(),
      createdNotebookId: created?.notebookId ?? null,
      routes,
      notebook,
      renewal,
      limitations,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    writeHumanTable(report);

    // The reconnect check is an assertion, not a metric: a stable session must
    // not dial a new WebSocket or reload the document across a focus/visibility
    // cycle. Fail the process loudly so a regression cannot pass silently.
    if (!reconnect.stable) {
      const failed = Object.entries(reconnect.assertions)
        .filter(([, assertion]) => !assertion.pass)
        .map(([name, assertion]) => `${name} (${assertion.detail})`)
        .join(", ");
      logStderr(
        `reconnect stability check FAILED for ${notebook.mode}: ${failed}. ` +
          "A stable session must not open a new WebSocket or reload the document.",
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// Runs before the viewer bundle on every document load: seeds loopback dev auth
// so cold navigations are authenticated, then installs buffered observers whose
// results the metric reader drains after settle. A full reload creates a fresh
// window, so these collectors reset per document by design.
function profileInitScript(seed) {
  try {
    localStorage.setItem(seed.devTokenKey, seed.devToken);
    localStorage.setItem(seed.userKey, seed.user);
    localStorage.setItem(seed.scopeKey, seed.scope);
  } catch {
    // Storage may be unavailable on error pages; auth simply stays unset.
  }
  const store = (window.__nteractProfile = window.__nteractProfile || {
    longTasks: [],
    events: [],
    longTaskObserverAttached: false,
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
    // Only mark attached once observe() returns; a swallowed setup error must not
    // masquerade as a zero-long-task run, which reads as a perfect TBT proxy.
    store.longTaskObserverAttached = true;
  } catch {
    // longtask timing is Chromium-only; when the observer cannot attach the TBT
    // proxy is reported as unavailable, never a misleading 0.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.events.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId ?? 0,
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {
    // event timing is Chromium-only; absence degrades to a null INP proxy.
  }
}

// Runs before the viewer bundle so browser-signals.ts reads a controllable
// visibility state. documentVisible$ gates on `document.visibilityState ===
// "visible"`; that property is read-only, so dispatching `visibilitychange`
// without changing it never flips the gate. These prototype getters read a
// window-scoped override and fall back to the real value when the harness has
// not set one, letting driveVisibilityCycle exercise both the hidden and visible
// edges of the real gate code.
function visibilityOverrideInitScript() {
  const proto = Document.prototype;
  const realVisibility = Object.getOwnPropertyDescriptor(proto, "visibilityState");
  const realHidden = Object.getOwnPropertyDescriptor(proto, "hidden");
  if (!realVisibility?.get || !realHidden?.get) {
    return;
  }
  const override = () => {
    const value = window.__nteractVisibilityOverride;
    return value === "visible" || value === "hidden" ? value : null;
  };
  Object.defineProperty(proto, "visibilityState", {
    configurable: true,
    get() {
      return override() ?? realVisibility.get.call(this);
    },
  });
  Object.defineProperty(proto, "hidden", {
    configurable: true,
    get() {
      const value = override();
      return value === null ? realHidden.get.call(this) : value === "hidden";
    },
  });
}

// Drives one hidden -> visible cycle through the override the gate reads, firing
// the same blur/focus and visibilitychange events a real tab-switch does. The
// override flip is what makes browser-signals' documentVisible$ actually observe
// false then true.
async function driveVisibilityCycle(page) {
  await page.evaluate(() => {
    window.__nteractVisibilityOverride = "hidden";
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__nteractVisibilityOverride = "visible";
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2_000);
}

async function profileRoute(
  context,
  { baseUrl, routePath, label, settleMs, readySelector, interactionCandidates },
) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const url = new URL(routePath, baseUrl);
  url.searchParams.set("profile", "1");

  const startedAt = Date.now();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .waitForSelector(readySelector, { timeout: READY_TIMEOUT_MS })
    .catch(() =>
      logStderr(`${label}: ready selector ${readySelector} not seen; collecting anyway`),
    );
  await page.waitForTimeout(settleMs);

  const interaction = await runInteractionProbe(page, interactionCandidates);
  await page.waitForTimeout(1_000);

  const metrics = await page.evaluate(collectPageMetrics, {
    clickStart: interaction.clickStart,
    clicked: interaction.clicked,
  });
  const renderCounts = await page.evaluate(() => window.__nteractRenderCounts ?? null);
  await network.settle();
  await page.close();

  return {
    route: routePath,
    label,
    wallClockMs: Date.now() - startedAt,
    marks: metrics.marks,
    navigationTiming: metrics.navigationTiming,
    paint: metrics.paint,
    longTasks: metrics.longTasks,
    interaction: {
      target: interaction.target,
      clicked: metrics.interaction.clicked,
      inpAvailable: metrics.interaction.available,
      inpProxyMs: metrics.interaction.maxDurationMs,
      inpUnavailableReason: metrics.interaction.unavailableReason,
      eventCount: metrics.interaction.count,
      sampleEvents: metrics.interaction.sample,
    },
    jsTransferBytes: {
      networkBodyBytes: network.jsBodyBytes(),
      networkContentLengthBytes: network.jsContentLengthBytes(),
      resourceTimingEncodedBytes: metrics.jsResourceTimingBytes,
      jsResponseCount: network.jsResponseCount(),
    },
    webSockets: network.webSockets(),
    renderCounts,
  };
}

async function profileNotebookReconnect(context, { origin, created }) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const viewerUrl = rebaseUrl(created.viewerUrl, origin);
  viewerUrl.searchParams.set("profile", "1");

  const startedAt = Date.now();
  await page.goto(viewerUrl.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .waitForSelector('[data-testid="notebook-toolbar"], main.nb-app', { timeout: READY_TIMEOUT_MS })
    .catch(() => logStderr("notebook: toolbar not seen; collecting anyway"));
  await page.waitForTimeout(NOTEBOOK_SETTLE_MS);

  const marks = await page.evaluate(collectMarks);
  const navigationTiming = await page.evaluate(collectNavigationTiming);
  const wsBefore = network.webSockets().length;
  const nonce = await page.evaluate(() => {
    const value = Math.random().toString(36).slice(2);
    window.__nteractReloadNonce = value;
    return value;
  });

  // Exercise the window focus / visibility path twice, ~2s apart, the way a
  // tab-switch would. onFocusChange in cloud-notebook-host.ts and the
  // browser-signals visibility subject listen for these; a stable session must
  // not dial a new WebSocket or reload the document in response.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await driveVisibilityCycle(page);
  }

  const wsAfter = network.webSockets().length;
  const nonceSurvived = await page.evaluate(
    (value) => window.__nteractReloadNonce === value,
    nonce,
  );
  const renderCounts = await page.evaluate(() => window.__nteractRenderCounts ?? null);
  await page.close();

  return {
    mode: "notebook-room",
    notebookId: created.notebookId,
    viewerUrl: viewerUrl.href,
    wallClockMs: Date.now() - startedAt,
    marks,
    navigationTiming,
    webSockets: network.webSockets(),
    reconnect: summarizeReconnect({
      webSocketsBefore: wsBefore,
      webSocketsAfter: wsAfter,
      reloaded: !nonceSurvived,
    }),
    renderCounts,
  };
}

async function profileListReconnect(context, { baseUrl }) {
  const page = await context.newPage();
  const network = attachNetworkCollectors(page);
  const url = new URL("/n", baseUrl);
  url.searchParams.set("profile", "1");

  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector("main.nb-app", { timeout: READY_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(NOTEBOOK_SETTLE_MS);

  const wsBefore = network.webSockets().length;
  const nonce = await page.evaluate(() => {
    const value = Math.random().toString(36).slice(2);
    window.__nteractReloadNonce = value;
    return value;
  });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await driveVisibilityCycle(page);
  }
  const wsAfter = network.webSockets().length;
  const nonceSurvived = await page.evaluate(
    (value) => window.__nteractReloadNonce === value,
    nonce,
  );
  await page.close();

  return {
    mode: "notebook-list",
    wallClockMs: null,
    marks: [],
    navigationTiming: null,
    webSockets: network.webSockets(),
    reconnect: summarizeReconnect({
      webSocketsBefore: wsBefore,
      webSocketsAfter: wsAfter,
      reloaded: !nonceSurvived,
    }),
    renderCounts: null,
  };
}

// Turns the raw reconnect observations into named pass/fail assertions plus an
// overall stable flag. The stability contract is the invariant the process exit
// code enforces: no new WebSocket, no document reload across a focus cycle.
function summarizeReconnect({ webSocketsBefore, webSocketsAfter, reloaded }) {
  const openedNewWebSocket = webSocketsAfter > webSocketsBefore;
  const assertions = {
    noNewWebSocket: {
      pass: !openedNewWebSocket,
      detail: `webSockets ${webSocketsBefore} -> ${webSocketsAfter}`,
    },
    documentNotReloaded: {
      pass: !reloaded,
      detail: reloaded ? "reload nonce did not survive" : "reload nonce survived",
    },
  };
  return {
    webSocketsBefore,
    webSocketsAfter,
    openedNewWebSocket,
    reloaded,
    stable: assertions.noNewWebSocket.pass && assertions.documentNotReloaded.pass,
    assertions,
  };
}

// Renewal-path check for the mounted dev OIDC issuer: prove that rotating the
// OIDC access token does not churn the live-room WebSocket. Runs in its own
// browser context so no loopback dev-token is seeded (a dev-token would win over
// OIDC in the viewer's auth read). It mints a token from the issuer, creates a
// room owned by the OIDC principal, exchanges the token for an app-session cookie
// (the credential the live-room socket actually uses), loads the room, then
// rotates the OIDC token and measures the socket count across the rotation.
//
// The rotation is driven here rather than by the viewer's own refresh timer: the
// notebook route suppresses that timer once an app session is fresh
// (appSessionRefreshFallback), so this instead calls the real issuer refresh
// grant and applies the result through a storage event, exercising the real
// store re-read while keeping the app session that decouples the socket from
// token rotation.
async function profileOidcRenewal(browser, { baseUrl, origin, limitations }) {
  if (!(await localOidcIssuerActive(origin))) {
    return { active: false, note: "dev OIDC issuer not mounted; renewal check skipped" };
  }

  let tokenSet;
  let notebook;
  try {
    tokenSet = await mintLocalOidcTokens(origin);
    notebook = await createOidcNotebook(baseUrl, origin, tokenSet.accessToken);
  } catch (error) {
    const note = `local OIDC setup failed (${errorText(error)}); renewal check skipped`;
    limitations.push(note);
    return { active: true, ran: false, note };
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const appSession = await establishAppSession(context, baseUrl, origin, tokenSet.accessToken);
    if (!appSession.ok) {
      limitations.push(
        `app-session exchange returned ${appSession.status}; the live-room socket ran without the cookie that keeps it stable across OIDC rotation`,
      );
    }

    await context.addInitScript(seedOidcTokenScript, {
      key: OIDC_TOKEN_STORAGE_KEY,
      token: oidcTokenState(tokenSet, decodeJwtClaims(tokenSet.accessToken)),
    });

    const page = await context.newPage();
    const network = attachNetworkCollectors(page);
    const viewerUrl = rebaseUrl(notebook.viewerUrl, origin);
    viewerUrl.searchParams.set("profile", "1");
    viewerUrl.searchParams.set("mode", "edit");

    const startedAt = Date.now();
    await page.goto(viewerUrl.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page
      .waitForSelector('[data-testid="notebook-toolbar"], main.nb-app', {
        timeout: READY_TIMEOUT_MS,
      })
      .catch(() => logStderr("renewal: toolbar not seen; collecting anyway"));
    await page.waitForTimeout(RENEWAL_SETTLE_MS);

    const wsBefore = network.webSockets().length;
    const storedBefore = await page.evaluate(readStoredOidcAccessToken, OIDC_TOKEN_STORAGE_KEY);
    const nonce = await page.evaluate(() => {
      const value = Math.random().toString(36).slice(2);
      window.__nteractReloadNonce = value;
      return value;
    });

    let rotationApplied = false;
    try {
      const rotated = await refreshLocalOidcTokens(origin, tokenSet.refreshToken);
      await page.evaluate(applyRotatedOidcToken, {
        key: OIDC_TOKEN_STORAGE_KEY,
        token: oidcTokenState(rotated, decodeJwtClaims(rotated.accessToken)),
      });
      rotationApplied = true;
    } catch (error) {
      limitations.push(`local OIDC refresh grant failed (${errorText(error)})`);
    }

    // The store also re-reads auth on focus/visibility; nudge both so a rotation
    // is observed the way a real tab-return would trigger it.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(RENEWAL_SETTLE_MS);

    const wsAfter = network.webSockets().length;
    const storedAfter = await page.evaluate(readStoredOidcAccessToken, OIDC_TOKEN_STORAGE_KEY);
    const nonceSurvived = await page.evaluate(
      (value) => window.__nteractReloadNonce === value,
      nonce,
    );
    await page.close();

    const tokenRotated = rotationApplied && storedAfter !== null && storedAfter !== storedBefore;
    return {
      active: true,
      ran: true,
      notebookId: notebook.notebookId,
      appSession: appSession.ok,
      tokenRotated,
      wallClockMs: Date.now() - startedAt,
      webSockets: network.webSockets(),
      reconnect: summarizeReconnect({
        webSocketsBefore: wsBefore,
        webSocketsAfter: wsAfter,
        reloaded: !nonceSurvived,
      }),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function localOidcIssuerActive(origin) {
  const url = new URL(`${LOCAL_OIDC_MOUNT_PATH}/.well-known/openid-configuration`, origin);
  try {
    const response = await fetch(url.href, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function mintLocalOidcTokens(origin) {
  const authorizeUrl = new URL(`${LOCAL_OIDC_MOUNT_PATH}/authorize`, origin);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", LOCAL_OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", new URL("/oidc", origin).href);
  authorizeUrl.searchParams.set("scope", LOCAL_OIDC_SCOPE);
  authorizeUrl.searchParams.set("state", Math.random().toString(36).slice(2));

  const authorizeResponse = await fetch(authorizeUrl.href, { redirect: "manual" });
  const location = authorizeResponse.headers.get("location");
  if (!location) {
    throw new Error(`authorize did not redirect (status ${authorizeResponse.status})`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error("authorize redirect is missing a code");
  }
  return exchangeLocalOidcToken(origin, {
    grant_type: "authorization_code",
    code,
    client_id: LOCAL_OIDC_CLIENT_ID,
    redirect_uri: new URL("/oidc", origin).href,
  });
}

function refreshLocalOidcTokens(origin, refreshToken) {
  return exchangeLocalOidcToken(origin, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: LOCAL_OIDC_CLIENT_ID,
    scope: LOCAL_OIDC_SCOPE,
  });
}

async function exchangeLocalOidcToken(origin, form) {
  const response = await fetch(new URL(`${LOCAL_OIDC_MOUNT_PATH}/token`, origin).href, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}`);
  }
  const body = await response.json();
  if (!body.access_token || !body.refresh_token) {
    throw new Error("token response missing access_token or refresh_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number.isFinite(body.expires_in) ? body.expires_in : 3600,
  };
}

async function createOidcNotebook(baseUrl, origin, accessToken) {
  const response = await fetch(new URL("/api/n", baseUrl).href, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Scope": "owner",
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ title: "profile-local renewal probe" }),
  });
  if (response.status !== 201) {
    throw new Error(`create notebook returned ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.notebook_id || !body.viewer_url) {
    throw new Error("create notebook response missing notebook_id or viewer_url");
  }
  return { notebookId: body.notebook_id, viewerUrl: body.viewer_url };
}

async function establishAppSession(context, baseUrl, origin, accessToken) {
  const response = await context.request.post(new URL("/api/auth/session", baseUrl).href, {
    headers: { Authorization: `Bearer ${accessToken}`, Origin: origin },
  });
  return { ok: response.ok(), status: response.status() };
}

function oidcTokenState(tokenSet, claims) {
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + tokenSet.expiresIn,
    claims,
  };
}

function decodeJwtClaims(jwt) {
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("access token is not a JWT");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const claims = { sub: parsed.sub };
  for (const field of ["email", "email_verified", "given_name", "name"]) {
    if (parsed[field] !== undefined) {
      claims[field] = parsed[field];
    }
  }
  return claims;
}

// Runs in the page before the viewer boots, seeding the OIDC session the viewer
// reads. Self-contained: page functions cannot close over harness scope.
function seedOidcTokenScript(seed) {
  try {
    localStorage.setItem(seed.key, JSON.stringify(seed.token));
  } catch {
    // Storage may be unavailable on error pages; the session simply stays unset.
  }
}

// Runs in the page. Replaces the stored OIDC session and dispatches the storage
// event the auth store listens for, so a same-tab rotation is observed the way a
// cross-tab token write would be.
function applyRotatedOidcToken(payload) {
  const oldValue = localStorage.getItem(payload.key);
  const newValue = JSON.stringify(payload.token);
  localStorage.setItem(payload.key, newValue);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: payload.key,
      oldValue,
      newValue,
      storageArea: localStorage,
    }),
  );
}

function readStoredOidcAccessToken(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}").accessToken ?? null;
  } catch {
    return null;
  }
}

async function runInteractionProbe(page, candidates) {
  for (const candidate of candidates) {
    const locator = page.locator(candidate.selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const clickStart = await page.evaluate(() => performance.now());
    // A swallowed click failure must not read as a successful interaction, so
    // record the outcome instead of dropping the error. Only a click that
    // actually resolved lets the INP proxy report a value.
    let clicked = false;
    try {
      await locator.click({ timeout: 5_000 });
      clicked = true;
    } catch (error) {
      logStderr(`interaction probe: click on ${candidate.selector} failed (${errorText(error)})`);
    }
    return { target: candidate.label, selector: candidate.selector, clickStart, clicked };
  }
  return { target: null, selector: null, clickStart: null, clicked: false };
}

function attachNetworkCollectors(page) {
  const responses = [];
  const sockets = [];
  const bodyPromises = [];
  page.on("response", (response) => {
    const request = response.request();
    const type = request.resourceType();
    const entry = {
      url: response.url(),
      resourceType: type,
      status: response.status(),
      contentLength: Number(response.headers()["content-length"] ?? 0),
      bodyBytes: null,
    };
    responses.push(entry);
    // Wrangler dev serves assets chunked without content-length, so read the
    // decoded body length to get real transfer bytes from the network events.
    if (type === "script") {
      bodyPromises.push(
        response
          .body()
          .then((buffer) => {
            entry.bodyBytes = buffer.length;
          })
          .catch(() => {}),
      );
    }
  });
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
  });
  const scripts = () => responses.filter((entry) => entry.resourceType === "script");
  return {
    settle: () => Promise.all(bodyPromises),
    jsBodyBytes: () => scripts().reduce((sum, entry) => sum + (entry.bodyBytes ?? 0), 0),
    jsContentLengthBytes: () =>
      scripts().reduce(
        (sum, entry) => sum + (Number.isFinite(entry.contentLength) ? entry.contentLength : 0),
        0,
      ),
    jsResponseCount: () => scripts().length,
    webSockets: () => [...sockets],
  };
}

// Evaluated in the page. `clickStart` scopes the event-timing entries to the one
// scripted interaction so the INP proxy is that interaction's worst event, and
// `clicked` gates whether an INP value is reportable at all.
function collectPageMetrics({ clickStart, clicked }) {
  const store = window.__nteractProfile || {
    longTasks: [],
    events: [],
    longTaskObserverAttached: false,
  };

  const marks = performance
    .getEntriesByType("mark")
    .filter((mark) => mark.name.startsWith("nteract:notebook-cloud:"))
    .map((mark) => ({
      name: mark.name.replace("nteract:notebook-cloud:", ""),
      startTimeMs: Math.round(mark.startTime),
    }));

  const nav = performance.getEntriesByType("navigation")[0];
  const navigationTiming = nav
    ? {
        responseEndMs: Math.round(nav.responseEnd),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        domCompleteMs: Math.round(nav.domComplete),
        loadEventEndMs: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize,
      }
    : null;

  const paint = {};
  for (const entry of performance.getEntriesByType("paint")) {
    paint[entry.name] = Math.round(entry.startTime);
  }

  // Without a live observer the long-task array is empty for the wrong reason,
  // so the TBT proxy is unavailable rather than a clean 0.
  const longTaskObserverAttached = Boolean(store.longTaskObserverAttached);
  const longTasks = store.longTasks || [];
  const longTaskTotalMs = longTaskObserverAttached
    ? Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0))
    : null;
  const tbtProxyMs = longTaskObserverAttached
    ? Math.round(longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0))
    : null;

  // Report an INP proxy only when the scripted click verifiably landed and the
  // event-timing API attributed entries to it (a non-zero interactionId). A
  // clickStart of 0/null must not admit unrelated events, and no click means no
  // value: unavailable, never a fabricated fallback.
  const clickLanded = clicked === true && typeof clickStart === "number" && clickStart > 0;
  const interactionEvents = clickLanded
    ? (store.events || []).filter(
        (entry) => entry.startTime >= clickStart && entry.interactionId !== 0,
      )
    : [];
  const inpAvailable = clickLanded && interactionEvents.length > 0;
  const maxDurationMs = inpAvailable
    ? Math.round(Math.max(...interactionEvents.map((entry) => entry.duration)))
    : null;
  const inpUnavailableReason = inpAvailable
    ? null
    : clicked === true
      ? "click landed but produced no correlated event-timing entries"
      : "no interaction target was clicked";

  const jsResourceTimingBytes = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.initiatorType === "script" || /\.js(\?|$)/.test(entry.name))
    .reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0);

  return {
    marks,
    navigationTiming,
    paint,
    longTasks: {
      observerAttached: longTaskObserverAttached,
      count: longTasks.length,
      totalMs: longTaskTotalMs,
      tbtProxyMs,
      unavailableReason: longTaskObserverAttached ? null : "longtask observer failed to attach",
    },
    interaction: {
      clicked: clicked === true,
      available: inpAvailable,
      count: interactionEvents.length,
      maxDurationMs,
      unavailableReason: inpUnavailableReason,
      sample: interactionEvents.slice(0, 8).map((entry) => ({
        name: entry.name,
        durationMs: Math.round(entry.duration),
      })),
    },
    jsResourceTimingBytes,
  };
}

function collectMarks() {
  return performance
    .getEntriesByType("mark")
    .filter((mark) => mark.name.startsWith("nteract:notebook-cloud:"))
    .map((mark) => ({
      name: mark.name.replace("nteract:notebook-cloud:", ""),
      startTimeMs: Math.round(mark.startTime),
    }));
}

function collectNavigationTiming() {
  const nav = performance.getEntriesByType("navigation")[0];
  if (!nav) {
    return null;
  }
  return {
    responseEndMs: Math.round(nav.responseEnd),
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    domCompleteMs: Math.round(nav.domComplete),
    loadEventEndMs: Math.round(nav.loadEventEnd),
    transferSize: nav.transferSize,
  };
}

async function createLoopbackNotebook(context, baseUrl, origin) {
  const response = await context.request.post(new URL("/api/n", baseUrl).href, {
    headers: {
      [DEV_TOKEN_HEADER]: DEV_TOKEN,
      "X-User": DEV_USER,
      "X-Scope": DEV_SCOPE,
      "Content-Type": "application/json",
      Origin: origin,
    },
    // The worker exposes no notebook-delete endpoint, so this probe outlives the
    // run. The ISO-8601 prefix lets an operator find and sweep old probes by age.
    data: { title: `${new Date().toISOString()} profile-local reconnect probe` },
  });
  if (response.status() !== 201) {
    throw new Error(`create notebook returned ${response.status()}: ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.notebook_id || !body.viewer_url) {
    throw new Error("create notebook response missing notebook_id or viewer_url");
  }
  return { notebookId: body.notebook_id, viewerUrl: body.viewer_url };
}

async function waitForWorkerReady(baseUrl) {
  const healthUrl = new URL("/api/health", baseUrl).href;
  const deadline = Date.now() + 30_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(500);
  }
  throw new Error(`worker at ${baseUrl} not ready within 30s (last: ${lastError})`);
}

function writeHumanTable(report) {
  const lines = [];
  lines.push("");
  lines.push(`cloud viewer profile  base=${report.baseUrl}  settle=${report.settleMs}ms`);
  lines.push("-".repeat(88));
  const header = [
    pad("route", 15),
    pad("marks", 7),
    pad("dclMs", 7),
    pad("tbtMs", 7),
    pad("inpMs", 7),
    pad("jsKB", 8),
    pad("ws", 4),
    pad("renders", 8),
  ].join(" ");
  lines.push(header);
  for (const [routePath, route] of Object.entries(report.routes)) {
    lines.push(
      [
        pad(routePath, 15),
        pad(String(route.marks.length), 7),
        pad(numOrDash(route.navigationTiming?.domContentLoadedMs), 7),
        pad(tbtCell(route.longTasks), 7),
        pad(inpCell(route.interaction), 7),
        pad(kb(bestJsBytes(route.jsTransferBytes)), 8),
        pad(String(route.webSockets.length), 4),
        pad(renderTotal(route.renderCounts), 8),
      ].join(" "),
    );
  }
  lines.push("-".repeat(88));
  const nb = report.notebook;
  if (nb) {
    lines.push(`reconnect (${nb.mode}) marks=${nb.marks.length}`);
    lines.push(
      `  ws ${nb.reconnect.webSocketsBefore} -> ${nb.reconnect.webSocketsAfter}` +
        `  newWs=${nb.reconnect.openedNewWebSocket}  reloaded=${nb.reconnect.reloaded}` +
        `  stable=${nb.reconnect.stable}  [${nb.reconnect.stable ? "PASS" : "FAIL"}]`,
    );
    if (nb.marks.length) {
      lines.push(
        `  marks: ${nb.marks.map((mark) => `${mark.name}@${mark.startTimeMs}`).join(", ")}`,
      );
    }
  }
  const renewal = report.renewal;
  if (renewal) {
    lines.push("-".repeat(88));
    if (!renewal.active) {
      lines.push("renewal: dev OIDC issuer not mounted; skipped");
    } else if (!renewal.ran) {
      lines.push(`renewal: skipped (${renewal.note})`);
    } else {
      lines.push(
        `renewal (oidc) appSession=${renewal.appSession} tokenRotated=${renewal.tokenRotated}`,
      );
      lines.push(
        `  ws ${renewal.reconnect.webSocketsBefore} -> ${renewal.reconnect.webSocketsAfter}` +
          `  newWs=${renewal.reconnect.openedNewWebSocket}  reloaded=${renewal.reconnect.reloaded}` +
          `  stable=${renewal.reconnect.stable}`,
      );
    }
  }
  if (report.limitations.length) {
    lines.push("limitations:");
    for (const note of report.limitations) {
      lines.push(`  - ${note}`);
    }
  }
  lines.push("");
  logStderr(lines.join("\n"));
}

function bestJsBytes(jsTransferBytes) {
  return (
    jsTransferBytes.networkBodyBytes ||
    jsTransferBytes.networkContentLengthBytes ||
    jsTransferBytes.resourceTimingEncodedBytes ||
    0
  );
}

function renderTotal(renderCounts) {
  if (!renderCounts) {
    return "-";
  }
  const total = Object.values(renderCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  return String(total);
}

function rebaseUrl(value, origin) {
  const url = new URL(value, origin);
  const base = new URL(origin);
  url.protocol = base.protocol;
  url.host = base.host;
  return url;
}

function numOrDash(value) {
  return value === null || value === undefined ? "-" : String(value);
}

// TBT and INP cells distinguish "measured as 0" from "could not measure": an
// unattached long-task observer or an interaction that never landed prints
// "unavail" so a reader never mistakes an absent property for a clean zero.
function tbtCell(longTasks) {
  return longTasks.observerAttached ? numOrDash(longTasks.tbtProxyMs) : "unavail";
}

function inpCell(interaction) {
  return interaction.inpAvailable ? numOrDash(interaction.inpProxyMs) : "unavail";
}

function kb(bytes) {
  if (!bytes) {
    return "0";
  }
  return (bytes / 1024).toFixed(1);
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStderr(message) {
  process.stderr.write(`${message}\n`);
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
