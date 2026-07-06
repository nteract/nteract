import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { establishCloudAppSessionFromOidcTokenWithRetry } from "../app-session";
import { OidcCallbackView, type OidcCallbackViewDeps } from "../oidc-callback-view";
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

// In-memory CloudOidcStorage: node's jsdom localStorage shim is unreliable
// locally, and the view takes storage as an injectable dep anyway.
function memoryStorage(): CloudOidcStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("OidcCallbackView", () => {
  let storage: CloudOidcStorage;

  beforeEach(() => {
    storage = memoryStorage();
    window.history.pushState({}, "", "/oidc?code=code-123&state=state-123");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows retry recovery for OIDC timeouts", async () => {
    render(
      <OidcCallbackView
        authConfig={authConfig}
        deps={{
          completeOidcRedirect: async () => {
            throw new OidcTimeoutError("discovery");
          },
          storage,
          navigate: inertNavigation(),
        }}
      />,
    );

    expect(
      await screen.findByText(
        "The sign-in provider did not respond. Try again to restart sign-in.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to nteract" })).toBeTruthy();
  });

  it("retries by starting a fresh login with the preserved return URL", async () => {
    storeRequestState(storage, "/n/private-demo?from=callback");
    const assign = vi.fn();
    let beginCalls = 0;
    const beginOidcLogin: NonNullable<OidcCallbackViewDeps["beginOidcLogin"]> = async (
      _oidc,
      input,
    ) => {
      beginCalls += 1;
      expect(input.currentUrl).toBe("/n/private-demo?from=callback");
      expect(input.storage).toBe(storage);
      return new URL("https://auth.example.test/api/auth/authorize?client_id=client-id");
    };

    render(
      <OidcCallbackView
        authConfig={authConfig}
        deps={{
          beginOidcLogin,
          completeOidcRedirect: async () => {
            throw new Error("OIDC token exchange failed: 503");
          },
          storage,
          navigate: {
            ...inertNavigation(),
            assign,
          },
        }}
      />,
    );

    await screen.findByText("OIDC token exchange failed: 503");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(beginCalls).toBe(1));
    expect(assign).toHaveBeenCalledWith(
      "https://auth.example.test/api/auth/authorize?client_id=client-id",
    );
  });

  it("establishes an app session and returns to the callback return URL", async () => {
    const token = oidcToken();
    const establishAppSession = vi.fn(async () => {});
    const replace = vi.fn();

    render(
      <OidcCallbackView
        authConfig={authConfig}
        deps={{
          completeOidcRedirect: async () => ({ returnUrl: "/n/private-demo", token }),
          establishAppSession,
          storage,
          navigate: {
            ...inertNavigation(),
            replace,
          },
        }}
      />,
    );

    await waitFor(() => expect(establishAppSession).toHaveBeenCalledWith(token));
    expect(replace).toHaveBeenCalledWith("/n/private-demo");
  });

  it("still returns to the callback return URL when app-session retry fails twice", async () => {
    let fetchCalls = 0;
    const replace = vi.fn();

    render(
      <OidcCallbackView
        authConfig={authConfig}
        deps={{
          completeOidcRedirect: async () => ({
            returnUrl: "/n/private-demo",
            token: oidcToken(),
          }),
          establishAppSession: (token) =>
            establishCloudAppSessionFromOidcTokenWithRetry(token, {
              fetchImpl: async () => {
                fetchCalls += 1;
                return new Response("down", { status: 503 });
              },
              sleep: async () => {},
              timeoutSignal: stableTimeoutSignal,
            }),
          storage,
          navigate: {
            ...inertNavigation(),
            replace,
          },
        }}
      />,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/n/private-demo"));
    expect(fetchCalls).toBe(2);
  });
});

function inertNavigation() {
  return {
    assign: vi.fn(),
    replace: vi.fn(),
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
