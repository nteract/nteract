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
}));

vi.mock("../app-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-session")>()),
  readCloudAppSessionStatus: mocks.readCloudAppSessionStatus,
}));

import { useCloudAppSessionStatus } from "../use-cloud-auth";

describe("useCloudAppSessionStatus", () => {
  beforeEach(() => {
    mocks.readCloudAppSessionStatus.mockReset();
  });

  const session = (overrides: Partial<CloudAppSession> = {}): CloudAppSession => ({
    provider: "oidc",
    expires_at: 4_000_000_000,
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
    const renewed = session({ expires_at: 4_000_009_999 });
    mocks.readCloudAppSessionStatus.mockResolvedValue({ ok: true, session: renewed });

    const { result } = renderHook(() => useCloudAppSessionStatus(initial));
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
