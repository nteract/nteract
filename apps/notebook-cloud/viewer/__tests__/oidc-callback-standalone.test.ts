import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { establishCloudAppSessionFromOidcTokenWithRetry } from "../app-session";
import {
  loadOidcCallbackAuthConfig,
  startOidcCallback,
  type OidcCallbackLocation,
  type OidcCallbackNavigation,
} from "../oidc-callback-standalone";
import {
  NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
  OidcTimeoutError,
  type CloudOidcRequestState,
  type CloudOidcStorage,
  type CloudOidcTokenState,
} from "../oidc-auth";
import type { CloudViewerAuthConfig } from "../cloud-viewer-types";

const authConfig: CloudViewerAuthConfig = {
  localDev: null,
  oidc: {
    issuer: "https://auth.example.test/api/auth",
    clientId: "client-id",
    redirectUri: "http://localhost/oidc",
  },
};

let root: HTMLElement;

describe("standalone OIDC callback entry", () => {
  let storage: CloudOidcStorage;
  let navigation: OidcCallbackNavigation;
  let location: OidcCallbackLocation;

  beforeEach(() => {
    storage = memoryStorage();
    document.head.innerHTML = "";
    document.body.innerHTML = `<div id="root"></div>`;
    root = document.querySelector("#root")!;
    navigation = {
      assign: vi.fn(),
      replace: vi.fn(),
    };
    location = {
      href: "http://localhost/oidc?code=code-123&state=state-123",
      origin: "http://localhost",
      search: "?code=code-123&state=state-123",
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the shell auth-config script like the viewer app", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<script id="nteract-cloud-auth-config" type="application/json">
        {"oidc":{"issuer":" https://auth.example.test/api/auth ","clientId":" client-id ","redirectUri":" http://localhost/oidc "},"localDev":{"authUrl":"/local-auth","label":" Local "}}
      </script>`,
    );

    expect(loadOidcCallbackAuthConfig(document, "http://localhost")).toEqual({
      oidc: {
        issuer: "https://auth.example.test/api/auth",
        clientId: "client-id",
        redirectUri: "http://localhost/oidc",
        scope: "openid email profile offline_access",
      },
      localDev: {
        authUrl: "/local-auth",
        label: "Local",
      },
    });
  });

  it("shows retry recovery for OIDC timeouts", async () => {
    startOidcCallback({
      authConfig,
      completeOidcRedirect: async () => {
        throw new OidcTimeoutError("discovery");
      },
      location,
      navigate: navigation,
      root,
      storage,
    });

    await waitForText("The sign-in provider did not respond. Try again to restart sign-in.");
    expect(button("Try again")).toBeTruthy();
    expect(link("Back to nteract")?.getAttribute("href")).toBe("/");
  });

  it("retries by starting a fresh login with the preserved return URL", async () => {
    storeRequestState(storage, "/n/private-demo?from=callback");
    let beginCalls = 0;

    startOidcCallback({
      authConfig,
      beginOidcLogin: async (_oidc, input) => {
        beginCalls += 1;
        expect(input.currentUrl).toBe("/n/private-demo?from=callback");
        expect(input.storage).toBe(storage);
        return new URL("https://auth.example.test/api/auth/authorize?client_id=client-id");
      },
      completeOidcRedirect: async () => {
        throw new Error("OIDC token exchange failed: 503");
      },
      location,
      navigate: navigation,
      root,
      storage,
    });

    await waitForText("OIDC token exchange failed: 503");
    button("Try again")?.click();

    await waitFor(() => expect(beginCalls).toBe(1));
    expect(navigation.assign).toHaveBeenCalledWith(
      "https://auth.example.test/api/auth/authorize?client_id=client-id",
    );
  });

  it("establishes an app session and returns to the callback return URL", async () => {
    const token = oidcToken();
    const establishAppSession = vi.fn(async () => {});

    startOidcCallback({
      authConfig,
      completeOidcRedirect: async () => ({ returnUrl: "/n/private-demo", token }),
      establishAppSession,
      location,
      navigate: navigation,
      root,
      storage,
    });

    await waitFor(() => expect(establishAppSession).toHaveBeenCalledWith(token, expect.anything()));
    expect(navigation.replace).toHaveBeenCalledWith("/n/private-demo");
  });

  it("still returns to the callback return URL when app-session retry fails twice", async () => {
    let fetchCalls = 0;

    startOidcCallback({
      authConfig,
      completeOidcRedirect: async () => ({
        returnUrl: "/n/private-demo",
        token: oidcToken(),
      }),
      establishAppSession: (token, deps) =>
        establishCloudAppSessionFromOidcTokenWithRetry(token, deps),
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("down", { status: 503 });
      },
      location,
      navigate: navigation,
      root,
      sleep: async () => {},
      storage,
      timeoutSignal: stableTimeoutSignal,
    });

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/n/private-demo"));
    expect(fetchCalls).toBe(2);
  });

  it("renders terminal recovery states for missing config and missing callback params", () => {
    startOidcCallback({
      authConfig: { oidc: null, localDev: null },
      location,
      navigate: navigation,
      root,
      storage,
    });

    expect(root.textContent).toContain("OIDC sign-in is not configured for this host.");
    expect(button("Try again")).toBeNull();
    expect(link("Back to nteract")?.getAttribute("href")).toBe("/");

    document.body.innerHTML = `<div id="root"></div>`;
    root = document.querySelector("#root")!;
    startOidcCallback({
      authConfig,
      location: { ...location, href: "http://localhost/oidc", search: "" },
      navigate: navigation,
      root,
      storage,
    });

    expect(root.textContent).toContain("No sign-in callback is pending.");
    expect(button("Try again")).toBeNull();
    expect(link("Back to nteract")?.getAttribute("href")).toBe("/");
  });
});

function memoryStorage(): CloudOidcStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function storeRequestState(storage: CloudOidcStorage, returnUrl: string): void {
  storage.setItem(
    NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
    JSON.stringify({
      challenge: "challenge",
      verifier: "verifier",
      state: "state-123",
      returnUrl,
    } satisfies CloudOidcRequestState),
  );
}

function oidcToken(): CloudOidcTokenState {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 1_800,
    claims: { sub: "anaconda-user-123", name: "Alice" },
  };
}

function stableTimeoutSignal(): AbortSignal {
  return new AbortController().signal;
}

function button(name: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll("button")).find((item) => item.textContent === name) ?? null
  );
}

function link(name: string): HTMLAnchorElement | null {
  return Array.from(root.querySelectorAll("a")).find((item) => item.textContent === name) ?? null;
}

async function waitForText(text: string): Promise<void> {
  await waitFor(() => expect(root.textContent).toContain(text));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}
