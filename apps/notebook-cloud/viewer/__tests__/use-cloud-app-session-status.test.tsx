import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import type { CloudAppSession } from "../app-session";

// The page shell can already contain a verified app-session from the Worker.
// A fresh initial session must avoid an immediate /api/auth/session round trip.
// Explicit refreshes and stale/missing bootstrap sessions still read the
// endpoint, and content-equal responses keep object identity stable so effect
// dependency chains (resolveSyncAuth → live-room effect) do not reconnect.
// These tests render the real hook, pinning setState updater wiring that
// pure-reducer tests cannot.

const mocks = vi.hoisted(() => ({
  readCloudAppSessionStatus: vi.fn<() => Promise<{ ok: true; session: CloudAppSession | null }>>(),
  refreshStoredOidcToken: vi.fn<() => Promise<void>>(),
  storedOidcTokenNeedsRefresh: vi.fn<() => boolean>(),
}));

vi.mock("../app-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-session")>()),
  readCloudAppSessionStatus: mocks.readCloudAppSessionStatus,
}));

vi.mock("../oidc-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../oidc-auth")>()),
  refreshStoredOidcToken: mocks.refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh: mocks.storedOidcTokenNeedsRefresh,
}));

import { useCloudAppSessionStatus, useCloudPrototypeAuth } from "../use-cloud-auth";

describe("useCloudAppSessionStatus", () => {
  beforeEach(() => {
    mocks.readCloudAppSessionStatus.mockReset();
    mocks.refreshStoredOidcToken.mockReset();
    mocks.storedOidcTokenNeedsRefresh.mockReset();
    mocks.storedOidcTokenNeedsRefresh.mockReturnValue(false);
  });

  const session = (overrides: Partial<CloudAppSession> = {}): CloudAppSession => ({
    provider: "oidc",
    expires_at: 4_000_000_000,
    cache_key: "cache-a",
    ...overrides,
  });

  it("trusts a fresh initial session until an explicit refresh asks the endpoint", async () => {
    const initial = session();
    mocks.readCloudAppSessionStatus.mockResolvedValue({ ok: true, session: session() });

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
    expect(result.current.session).toBe(initial);

    await act(async () => {});
    expect(mocks.readCloudAppSessionStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    expect(result.current.session).toBe(initial);

    // A manual refresh that confirms again keeps it too.
    act(() => {
      result.current.refreshAppSessionStatus();
    });
    await waitFor(() => expect(mocks.readCloudAppSessionStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    expect(result.current.session).toBe(initial);
  });

  it("keeps stale initial session identity across content-equal confirming fetches", async () => {
    const initial = session({ expires_at: 1 });
    mocks.readCloudAppSessionStatus.mockResolvedValue({
      ok: true,
      session: session({ expires_at: 1 }),
    });

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
    expect(result.current.session).toBe(initial);

    await waitFor(() => expect(mocks.readCloudAppSessionStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    // The wiring pin: the fetch returned a fresh-but-content-identical
    // object, and the hook must keep the ORIGINAL reference.
    expect(result.current.session).toBe(initial);
  });

  it("adopts a genuinely renewed session", async () => {
    const initial = session({ expires_at: 1 });
    const renewed = session({ expires_at: 4_000_009_999, cache_key: "cache-b" });
    mocks.readCloudAppSessionStatus.mockResolvedValue({ ok: true, session: renewed });

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
    await waitFor(() => expect(mocks.readCloudAppSessionStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    expect(result.current.session).toBe(renewed);
  });

  it("adopts a session when only the cache boundary changes", async () => {
    const initial = session({ expires_at: 4_000_000_000, cache_key: "cache-a" });
    const renewed = session({ expires_at: 4_000_000_000, cache_key: "cache-b" });
    mocks.readCloudAppSessionStatus.mockResolvedValue({ ok: true, session: renewed });

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
    act(() => {
      result.current.refreshAppSessionStatus();
    });
    await waitFor(() => expect(mocks.readCloudAppSessionStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(result.current.status).toBe("ready");
    expect(result.current.session).toBe(renewed);
  });

  it("moves loading to ready with the fetched session when mounted without one", async () => {
    const fetched = session();
    mocks.readCloudAppSessionStatus.mockResolvedValue({ ok: true, session: fetched });

    const { result } = renderHook(() => useCloudAppSessionStatus(null));
    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.session).toBe(fetched);
  });

  it("reports fetch failures without dropping the session it already has", async () => {
    const initial = session({ expires_at: 1 });
    mocks.readCloudAppSessionStatus.mockRejectedValue(new Error("session endpoint down"));

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.error).toBe("session endpoint down");
    expect(result.current.session).toBe(initial);
  });
});

describe("useCloudPrototypeAuth", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.refreshStoredOidcToken.mockReset();
    mocks.refreshStoredOidcToken.mockResolvedValue();
    mocks.storedOidcTokenNeedsRefresh.mockReset();
    mocks.storedOidcTokenNeedsRefresh.mockReturnValue(true);
  });

  const authConfig = {
    localDev: null,
    oidc: {
      issuer: "https://auth.example.test",
      clientId: "client-id",
      redirectUri: "https://preview.example.test/oidc",
    },
  };

  it("can defer stale OIDC refresh until the route needs authenticated behavior", async () => {
    const { result, rerender } = renderHook(
      ({ autoRefreshOidc }: { autoRefreshOidc: boolean }) =>
        useCloudPrototypeAuth(authConfig, {
          appSession: null,
          appSessionLoading: false,
          appSessionRefreshFallback: true,
          autoRefreshOidc,
        }),
      { initialProps: { autoRefreshOidc: false } },
    );

    await act(async () => {});

    expect(result.current.authRenewal.kind).toBe("idle");
    expect(mocks.storedOidcTokenNeedsRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshStoredOidcToken).not.toHaveBeenCalled();

    rerender({ autoRefreshOidc: true });

    await waitFor(() => expect(mocks.refreshStoredOidcToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.authRenewal.kind).toBe("idle"));
  });
});
