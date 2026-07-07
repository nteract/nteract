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
    message: "Completing sign-in...",
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
      render({ kind: "ready", message: "Signed in. Returning to the notebook..." });
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
  const brand = element(doc, "h1");
  brand.textContent = "nteract";
  const strapline = element(doc, "span");
  strapline.textContent = "returning to the notebook";
  copy.append(brand, strapline);

  const panel = element(doc, "section", "cloud-oidc-panel");
  panel.dataset.mode = status.kind;
  panel.setAttribute("aria-label", "Cloud sign-in status");

  const statusRow = element(doc, "div", "cloud-oidc-status");
  statusRow.dataset.mode = status.kind;
  statusRow.setAttribute("role", status.kind === "error" ? "alert" : "status");

  const icon = element(doc, "span", "cloud-oidc-status-icon");
  icon.setAttribute("aria-hidden", "true");

  const statusCopy = element(doc, "div");
  const title = element(doc, "h2");
  title.textContent = statusTitle(status.kind);
  const message = element(doc, "p");
  message.textContent = status.message;
  statusCopy.append(title, message);
  statusRow.append(icon, statusCopy);
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
      return "Signed in";
    case "error":
      return "Sign-in needs attention";
    case "empty":
      return "Nothing to finish";
    case "loading":
      return "Completing sign-in";
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
  return `
body {
  min-height: 100vh;
}

.cloud-oidc-shell {
  align-items: center;
  background:
    linear-gradient(140deg, color-mix(in oklch, var(--background) 88%, #178a7a 12%), transparent),
    var(--background);
  box-sizing: border-box;
  color: var(--foreground);
  display: flex;
  min-height: 100vh;
  padding: 32px;
}

.cloud-oidc-layout {
  align-items: center;
  display: grid;
  gap: 40px;
  grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 440px);
  margin: 0 auto;
  max-width: 920px;
  width: 100%;
}

.cloud-oidc-copy h1 {
  font-size: 48px;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1;
  margin: 0;
}

.cloud-oidc-copy span {
  color: color-mix(in oklch, var(--foreground) 66%, transparent);
  display: block;
  font-size: 15px;
  margin-top: 12px;
}

.cloud-oidc-panel {
  background: color-mix(in oklch, var(--background) 94%, var(--foreground) 6%);
  border: 1px solid color-mix(in oklch, var(--foreground) 14%, transparent);
  border-radius: 8px;
  box-shadow: 0 24px 70px color-mix(in oklch, var(--foreground) 10%, transparent);
  padding: 24px;
}

.cloud-oidc-status {
  align-items: flex-start;
  display: grid;
  gap: 16px;
  grid-template-columns: 28px 1fr;
}

.cloud-oidc-status-icon {
  border: 2px solid color-mix(in oklch, var(--foreground) 20%, transparent);
  border-radius: 999px;
  box-sizing: border-box;
  display: inline-block;
  height: 28px;
  margin-top: 2px;
  position: relative;
  width: 28px;
}

.cloud-oidc-status[data-mode="loading"] .cloud-oidc-status-icon {
  animation: cloud-oidc-spin 850ms linear infinite;
  border-color: color-mix(in oklch, #178a7a 70%, var(--foreground) 30%);
  border-right-color: transparent;
}

.cloud-oidc-status[data-mode="ready"] .cloud-oidc-status-icon {
  background: color-mix(in oklch, #178a7a 18%, transparent);
  border-color: #178a7a;
}

.cloud-oidc-status[data-mode="ready"] .cloud-oidc-status-icon::after {
  border-bottom: 2px solid #178a7a;
  border-right: 2px solid #178a7a;
  content: "";
  height: 11px;
  left: 9px;
  position: absolute;
  top: 5px;
  transform: rotate(40deg);
  width: 6px;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon {
  background: color-mix(in oklch, #c85040 14%, transparent);
  border-color: #c85040;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::before,
.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::after {
  background: #c85040;
  content: "";
  left: 12px;
  position: absolute;
  width: 2px;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::before {
  height: 11px;
  top: 6px;
}

.cloud-oidc-status[data-mode="error"] .cloud-oidc-status-icon::after {
  border-radius: 999px;
  height: 2px;
  top: 20px;
}

.cloud-oidc-status[data-mode="empty"] .cloud-oidc-status-icon::before {
  background: color-mix(in oklch, var(--foreground) 60%, transparent);
  content: "";
  height: 10px;
  left: 11px;
  position: absolute;
  top: 8px;
  width: 2px;
}

.cloud-oidc-status h2 {
  font-size: 20px;
  font-weight: 640;
  letter-spacing: 0;
  line-height: 1.2;
  margin: 0;
}

.cloud-oidc-status p {
  color: color-mix(in oklch, var(--foreground) 72%, transparent);
  font-size: 14px;
  line-height: 1.5;
  margin: 8px 0 0;
}

.cloud-oidc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.cloud-oidc-button,
.cloud-oidc-link {
  align-items: center;
  border-radius: 6px;
  box-sizing: border-box;
  display: inline-flex;
  font: inherit;
  font-size: 14px;
  font-weight: 560;
  justify-content: center;
  min-height: 36px;
  padding: 0 14px;
  text-decoration: none;
}

.cloud-oidc-button {
  background: #178a7a;
  border: 1px solid #178a7a;
  color: white;
  cursor: pointer;
}

.cloud-oidc-button:disabled {
  cursor: progress;
  opacity: 0.72;
}

.cloud-oidc-link {
  border: 1px solid color-mix(in oklch, var(--foreground) 16%, transparent);
  color: var(--foreground);
}

@keyframes cloud-oidc-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .cloud-oidc-shell {
    align-items: stretch;
    padding: 24px;
  }

  .cloud-oidc-layout {
    align-content: center;
    gap: 24px;
    grid-template-columns: 1fr;
  }

  .cloud-oidc-copy h1 {
    font-size: 40px;
  }
}
`;
}

function browserStorage(): CloudOidcStorage {
  return window.localStorage;
}
