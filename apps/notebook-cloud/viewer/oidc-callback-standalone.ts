import { establishCloudAppSessionFromOidcTokenWithRetry } from "./app-session";
import { prepareCloudOidcViewerLogin } from "./collaborator-auth";
import {
  OidcTimeoutError,
  beginOidcLogin,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  peekOidcReturnUrl,
  type CloudOidcAuthConfig,
  type CloudOidcStorage,
} from "./oidc-auth";
import type { CloudViewerAuthConfig, CloudViewerLocalDevAuthConfig } from "./cloud-viewer-types";

export type OidcCallbackStatus =
  | { kind: "loading"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string; canRetry: boolean; retrying?: boolean };

export interface OidcCallbackNavigation {
  assign(url: string): void;
  replace(url: string): void;
}

export interface OidcCallbackLocation {
  href: string;
  origin: string;
  search: string;
}

export interface OidcCallbackStandaloneDeps {
  authConfig?: CloudViewerAuthConfig;
  beginOidcLogin?: typeof beginOidcLogin;
  completeOidcRedirect?: typeof completeOidcRedirect;
  document?: Document;
  establishAppSession?: typeof establishCloudAppSessionFromOidcTokenWithRetry;
  fetchImpl?: typeof fetch;
  location?: OidcCallbackLocation;
  navigate?: Partial<OidcCallbackNavigation>;
  prepareLogin?: typeof prepareCloudOidcViewerLogin;
  root?: HTMLElement;
  sleep?: (ms: number) => Promise<void>;
  storage?: CloudOidcStorage;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

export interface OidcCallbackController {
  getStatus(): OidcCallbackStatus;
  retry(): void;
}

const STYLE_ID = "nteract-cloud-oidc-style";

export function startOidcCallback(deps: OidcCallbackStandaloneDeps = {}): OidcCallbackController {
  const doc = deps.document ?? document;
  installOidcCallbackStyle(doc);
  const root = deps.root ?? doc.getElementById("root") ?? doc.body;
  const location = deps.location ?? window.location;
  const navigateAssign = deps.navigate?.assign ?? ((url: string) => window.location.assign(url));
  const navigateReplace = deps.navigate?.replace ?? ((url: string) => window.location.replace(url));
  const completeRedirect = deps.completeOidcRedirect ?? completeOidcRedirect;
  const startLogin = deps.beginOidcLogin ?? beginOidcLogin;
  const establishAppSession =
    deps.establishAppSession ?? establishCloudAppSessionFromOidcTokenWithRetry;
  const prepareLogin = deps.prepareLogin ?? prepareCloudOidcViewerLogin;
  const authConfig = deps.authConfig ?? loadOidcCallbackAuthConfig(doc, location.origin);
  const storage = deps.storage ?? browserStorage();
  const preservedReturnUrl = peekOidcReturnUrl(storage);
  let retryInFlight = false;
  let status: OidcCallbackStatus = {
    kind: "loading",
    message: "Returning you to your notebook.",
  };

  const render = (next: OidcCallbackStatus) => {
    status = next;
    renderOidcCallback(root, next, retryOidcLogin);
  };

  render(status);

  const oidc = authConfig.oidc;
  if (!oidc) {
    render({
      kind: "error",
      message: "OIDC sign-in is not configured for this host.",
      canRetry: false,
    });
    return controller();
  }

  const params = new URLSearchParams(location.search);
  if (!params.has("code") || !params.has("state")) {
    render({ kind: "empty", message: "No sign-in callback is pending." });
    return controller();
  }

  void completeRedirect(oidc, {
    callbackUrl: location.href,
    fetchImpl: deps.fetchImpl,
    storage,
    timeoutSignal: deps.timeoutSignal,
  })
    .then(async ({ returnUrl, token }) => {
      await establishAppSession(token, {
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        timeoutSignal: deps.timeoutSignal,
      }).catch((error: unknown) => {
        console.warn("[notebook-cloud] app session exchange failed", error);
      });
      render({ kind: "ready", message: "Returning you to your notebook." });
      navigateReplace(returnUrl);
    })
    .catch((error: unknown) => {
      render(oidcCallbackExchangeErrorStatus(error));
    });

  function retryOidcLogin(): void {
    if (!oidc || retryInFlight) {
      return;
    }
    retryInFlight = true;
    render({ ...oidcCallbackRetryingStatus(status), retrying: true });
    prepareLogin(storage);
    void startLogin(oidc, {
      currentUrl: preservedReturnUrl ?? "/n",
      fetchImpl: deps.fetchImpl,
      storage,
      timeoutSignal: deps.timeoutSignal,
    })
      .then((url) => {
        navigateAssign(url.href);
      })
      .catch((error: unknown) => {
        retryInFlight = false;
        render(oidcCallbackRetryErrorStatus(error));
      });
  }

  function controller(): OidcCallbackController {
    return {
      getStatus: () => status,
      retry: retryOidcLogin,
    };
  }

  return controller();
}

export function loadOidcCallbackAuthConfig(
  doc: Pick<Document, "querySelector"> = document,
  locationOrigin = window.location.origin,
): CloudViewerAuthConfig {
  const element = doc.querySelector<HTMLScriptElement>("#nteract-cloud-auth-config");
  if (!element) {
    return { oidc: null, localDev: null };
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as {
      localDev?: Partial<CloudViewerLocalDevAuthConfig> | null;
      oidc?: Partial<CloudOidcAuthConfig> | null;
    };
    return {
      oidc: normalizeOidcAuthConfig(parsed.oidc),
      localDev: normalizeLocalDevAuthConfig(parsed.localDev, locationOrigin),
    };
  } catch {
    return { oidc: null, localDev: null };
  }
}

function normalizeLocalDevAuthConfig(
  input: Partial<CloudViewerLocalDevAuthConfig> | null | undefined,
  locationOrigin: string,
): CloudViewerLocalDevAuthConfig | null {
  const rawAuthUrl = input?.authUrl?.trim();
  if (!rawAuthUrl) {
    return null;
  }
  try {
    const authUrl = new URL(rawAuthUrl, locationOrigin);
    if (authUrl.origin !== locationOrigin) {
      return null;
    }
    const label = input?.label?.trim();
    return {
      authUrl: `${authUrl.pathname}${authUrl.search}${authUrl.hash}`,
      ...(label ? { label } : {}),
    };
  } catch {
    return null;
  }
}

function oidcCallbackExchangeErrorStatus(error: unknown): OidcCallbackStatus {
  if (error instanceof OidcTimeoutError) {
    return {
      kind: "error",
      canRetry: true,
      message: "The sign-in provider did not respond. Try again to restart sign-in.",
    };
  }
  return {
    kind: "error",
    canRetry: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

function oidcCallbackRetryErrorStatus(error: unknown): OidcCallbackStatus {
  return {
    kind: "error",
    canRetry: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

function oidcCallbackRetryingStatus(
  status: OidcCallbackStatus,
): Extract<OidcCallbackStatus, { kind: "error" }> {
  if (status.kind === "error") {
    return status;
  }
  return {
    kind: "error",
    canRetry: true,
    message: status.message,
  };
}

function renderOidcCallback(
  root: HTMLElement,
  status: OidcCallbackStatus,
  retry: () => void,
): void {
  const doc = root.ownerDocument;
  const main = element(doc, "main", "cloud-oidc-shell");
  main.setAttribute("aria-busy", status.kind === "loading" ? "true" : "false");

  const layout = element(doc, "section", "cloud-oidc-layout");
  layout.setAttribute("aria-label", "nteract sign-in callback");

  const copy = element(doc, "div", "cloud-oidc-copy");
  const kicker = element(doc, "div", "cloud-oidc-kicker");
  kicker.textContent = "NTERACT";
  const headline = element(doc, "h1");
  headline.textContent = statusTitle(status.kind);
  copy.append(kicker, headline);

  const panel = element(doc, "section", "cloud-oidc-panel");
  panel.dataset.mode = status.kind;
  panel.setAttribute("aria-label", "Cloud sign-in status");

  const statusRow = element(doc, "div", "cloud-oidc-status");
  statusRow.dataset.mode = status.kind;
  statusRow.setAttribute("role", status.kind === "error" ? "alert" : "status");

  const icon = element(doc, "span", "cloud-oidc-status-icon");
  icon.setAttribute("aria-hidden", "true");

  const message = element(doc, "p");
  message.textContent = status.message;
  statusRow.append(icon, message);
  panel.append(statusRow);

  if (status.kind === "error" || status.kind === "empty") {
    const actions = element(doc, "div", "cloud-oidc-actions");
    if (status.kind === "error" && status.canRetry) {
      const retryButton = element(doc, "button", "cloud-oidc-button");
      retryButton.type = "button";
      retryButton.disabled = Boolean(status.retrying);
      retryButton.textContent = status.retrying ? "Starting..." : "Try again";
      retryButton.addEventListener("click", retry);
      actions.append(retryButton);
    }
    const backLink = element(doc, "a", "cloud-oidc-link");
    backLink.setAttribute("href", "/");
    backLink.textContent = "Back to nteract";
    actions.append(backLink);
    panel.append(actions);
  }

  layout.append(copy, panel);
  main.append(layout);
  root.replaceChildren(main);
}

function statusTitle(kind: OidcCallbackStatus["kind"]): string {
  switch (kind) {
    case "ready":
      return "Signed in.";
    case "error":
      return "Sign-in needs attention.";
    case "empty":
      return "Nothing to finish.";
    case "loading":
      return "Completing sign-in.";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const item = doc.createElement(tag);
  if (className) {
    item.className = className;
  }
  return item;
}

function installOidcCallbackStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = oidcCallbackStyle();
  doc.head.append(style);
}

function oidcCallbackStyle(): string {
  // This entry stays standalone (no viewer stylesheet, see
  // includeViewerStylesheet: false in the Worker), so it carries its own copy
  // of the host tokens. Values mirror src/styles/notebook-base.css and the
  // cloud-home atoms in viewer/index.css; if the host chrome retunes, retune
  // here.
  return `
:root {
  color-scheme: light dark;
  --background: #ffffff;
  --foreground: oklch(0.145 0 0);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
  }
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  margin: 0;
  min-height: 100vh;
}

.cloud-oidc-shell {
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  min-height: 100vh;
}

.cloud-oidc-layout {
  display: grid;
  gap: clamp(2rem, 7vh, 4.5rem);
  align-content: center;
  padding-block: clamp(2rem, 10vh, 6rem);
  width: min(34rem, calc(100vw - clamp(2rem, 8vw, 6rem)));
}

.cloud-oidc-copy {
  display: grid;
  gap: 0.75rem;
  justify-items: center;
  text-align: center;
}

.cloud-oidc-kicker {
  color: color-mix(in srgb, #0f766e 72%, var(--foreground) 28%);
  font-size: 0.8125rem;
  font-weight: 760;
  letter-spacing: 0.08em;
  line-height: 1;
}

.cloud-oidc-copy h1 {
  color: var(--foreground);
  font-size: clamp(2.25rem, 6vw, 3.25rem);
  font-weight: 760;
  letter-spacing: 0;
  line-height: 1;
  margin: 0;
}

.cloud-oidc-panel {
  --cloud-oidc-panel-border: color-mix(in srgb, #10b981 68%, transparent);
  --cloud-oidc-panel-wash: color-mix(in srgb, #10b981 5%, var(--background));
  background: var(--cloud-oidc-panel-wash);
  border-top: 1px solid var(--cloud-oidc-panel-border);
  display: grid;
  gap: 0.875rem;
  padding: 0.75rem 0.25rem;
}

.cloud-oidc-panel[data-mode="empty"] {
  --cloud-oidc-panel-border: color-mix(in srgb, var(--foreground) 28%, transparent);
  --cloud-oidc-panel-wash: color-mix(in srgb, var(--foreground) 2%, var(--background));
}

.cloud-oidc-panel[data-mode="error"] {
  --cloud-oidc-panel-border: color-mix(in srgb, #b42318 54%, transparent);
  --cloud-oidc-panel-wash: color-mix(in srgb, #b42318 5%, var(--background));
}

.cloud-oidc-status {
  align-items: start;
  display: grid;
  gap: 0.75rem;
  grid-template-columns: auto minmax(0, 1fr);
}

.cloud-oidc-status p {
  color: color-mix(in srgb, var(--foreground) 72%, transparent);
  font-size: 0.875rem;
  line-height: 1.5;
  margin: 0.125rem 0 0;
  text-align: left;
}

.cloud-oidc-status-icon {
  border: 2px solid color-mix(in srgb, var(--foreground) 20%, transparent);
  border-radius: 999px;
  box-sizing: border-box;
  display: inline-block;
  height: 1.25rem;
  margin-top: 0.125rem;
  position: relative;
  width: 1.25rem;
}

.cloud-oidc-status[data-mode="loading"] .cloud-oidc-status-icon {
  animation: cloud-oidc-spin 850ms linear infinite;
  border-color: color-mix(in srgb, #0f766e 70%, var(--foreground) 30%);
  border-right-color: transparent;
}

.cloud-oidc-status[data-mode="ready"] .cloud-oidc-status-icon {
  background: color-mix(in srgb, #10b981 18%, transparent);
  border-color: #0f766e;
}

.cloud-oidc-status[data-mode="ready"] .cloud-oidc-status-icon::after {
  border-bottom: 2px solid #0f766e;
  border-right: 2px solid #0f766e;
  content: "";
  height: 0.5rem;
  left: 0.375rem;
  position: absolute;
  top: 0.125rem;
  transform: rotate(40deg);
  width: 0.25rem;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon {
  background: color-mix(in srgb, #b42318 14%, transparent);
  border-color: #b42318;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::before,
.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::after {
  background: #b42318;
  border-radius: 999px;
  content: "";
  height: 0.625rem;
  left: calc(50% - 1px);
  position: absolute;
  top: calc(50% - 0.3125rem);
  width: 2px;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::before {
  transform: rotate(45deg);
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::after {
  transform: rotate(-45deg);
}

.cloud-oidc-status[data-mode="empty"] .cloud-oidc-status-icon::before {
  background: color-mix(in srgb, var(--foreground) 60%, transparent);
  border-radius: 999px;
  content: "";
  height: 2px;
  left: calc(50% - 0.1875rem);
  position: absolute;
  top: calc(50% - 1px);
  width: 0.375rem;
}

.cloud-oidc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.cloud-oidc-button,
.cloud-oidc-link {
  align-items: center;
  background: color-mix(in srgb, var(--background) 94%, var(--foreground) 6%);
  border: 1px solid color-mix(in srgb, var(--foreground) 16%, transparent);
  border-radius: 6px;
  box-sizing: border-box;
  color: var(--foreground);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 0.875rem;
  justify-content: center;
  min-height: 2.25rem;
  padding-inline: 0.75rem;
  text-decoration: none;
}

.cloud-oidc-button:hover,
.cloud-oidc-link:hover {
  background: color-mix(in srgb, var(--background) 86%, var(--foreground) 10%);
}

.cloud-oidc-button:disabled {
  cursor: progress;
  opacity: 0.72;
}

@keyframes cloud-oidc-spin {
  to {
    transform: rotate(360deg);
  }
}
`;
}

function browserStorage(): CloudOidcStorage {
  return window.localStorage;
}
