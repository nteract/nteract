import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudAuthStoreProvider } from "../cloud-auth-context";
import { CloudAuthStore } from "../cloud-auth-store";
import type { CloudAppSessionStatus } from "../app-session";
import { cloudNotebookHomeStore } from "../cloud-notebook-home-store";
import type { CloudViewerAuthConfig } from "../cloud-viewer-types";
import type { CloudPrototypeAuthState } from "../collaborator-auth";
import { CloudNotebookListView } from "../notebook-list-view";
import { writeCachedCloudNotebookList } from "../notebook-list-cache";
import type { CloudNotebookListItem } from "../notebook-dashboard";

const authConfig: CloudViewerAuthConfig = {
  localDev: null,
  oidc: null,
};

describe("CloudNotebookListView", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    cloudNotebookHomeStore.seed(null, null);
    vi.useFakeTimers();
    storage = new MemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    window.history.pushState({}, "", "/n");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the dashboard shell through a cookie-only session check and delayed list", async () => {
    let resolveSession!: (status: CloudAppSessionStatus) => void;
    const session = new Promise<CloudAppSessionStatus>((resolve) => {
      resolveSession = resolve;
    });
    let resolveList!: (response: Response) => void;
    const list = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const fetchMock = vi.fn(() => list);
    vi.stubGlobal("fetch", fetchMock);
    // A previous account's browser cache is not identity authority for a
    // cookie-only boot, even while the server is slow to confirm the session.
    writeCachedCloudNotebookList(storage, oidcAuth("previous@example.test"), null, [
      notebook("private", "Previous account private notebook"),
    ]);
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      { authConfig, initialSession: null },
      {
        readAppSessionStatus: () => session,
      },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      expect(screen.getByRole("heading", { name: "Notebooks" })).toBeTruthy();
      expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
      expect(screen.getByRole("searchbox", { name: "Search notebooks" })).toHaveProperty(
        "disabled",
        true,
      );
      expect(screen.getByRole("button", { name: "New notebook" })).toHaveProperty("disabled", true);
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      expect(screen.queryByText("Previous account private notebook")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        resolveSession({
          ok: true,
          session: {
            provider: "oidc",
            expires_at: 9_999_999_999,
            cache_key: "new-account",
            display_name: "New Account",
          },
        });
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "New Account" })).toBeTruthy();
      expect(screen.queryByText("Previous account private notebook")).toBeNull();

      await act(async () => {
        resolveList(
          new Response(
            JSON.stringify({ ok: true, notebooks: [notebook("new", "Current account notebook")] }),
          ),
        );
      });
      expect(screen.getByRole("heading", { name: "Notebooks" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Current account notebook" })).toBeTruthy();
      expect(screen.queryByRole("status", { name: "Loading notebooks" })).toBeNull();
      expect(screen.getByRole("searchbox", { name: "Search notebooks" })).toHaveProperty(
        "disabled",
        false,
      );
    } finally {
      dispose();
    }
  });

  it("shows sign-in only after the cookie session check confirms signed-out", async () => {
    let resolveSession!: (status: CloudAppSessionStatus) => void;
    const session = new Promise<CloudAppSessionStatus>((resolve) => {
      resolveSession = resolve;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      { authConfig, initialSession: null },
      {
        readAppSessionStatus: () => session,
      },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
      expect(screen.queryByText("Bring computation to life.")).toBeNull();
      await act(async () => {
        resolveSession({ ok: true, session: null });
      });
      expect(screen.getByText("Bring computation to life.")).toBeTruthy();
      expect(screen.queryByRole("status", { name: "Loading notebooks" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New notebook" })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("keeps sign-out visible during the follow-up cookie session check", async () => {
    const fetchMock = vi.fn(
      async (_url, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "DELETE"
              ? { ok: true }
              : {
                  ok: true,
                  notebooks: [notebook("before-signout", "Before sign-out")],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const readSession = vi.fn(() => new Promise<CloudAppSessionStatus>(() => {}));
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      {
        authConfig,
        initialSession: {
          provider: "oidc",
          expires_at: 9_999_999_999,
          cache_key: "signout",
          display_name: "Test Account",
        },
      },
      { readAppSessionStatus: readSession },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.keyDown(screen.getByRole("button", { name: "Test Account" }), {
        key: "Enter",
        code: "Enter",
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
      });
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(store.appSessionSnapshot.status).toBe("loading");
      expect(screen.getByText("Bring computation to life.")).toBeTruthy();
      expect(screen.queryByRole("status", { name: "Loading notebooks" })).toBeNull();
      expect(screen.queryByText("Before sign-out")).toBeNull();
    } finally {
      dispose();
    }
  });

  it("bounds slow cookie-session feedback without fetching notebooks before confirmation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const readSession = vi.fn(() => new Promise<CloudAppSessionStatus>(() => {}));
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      { authConfig, initialSession: null },
      { readAppSessionStatus: readSession },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} appSessionWaitDeadlineMs={5} />
        </CloudAuthStoreProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(screen.getByRole("heading", { name: "Notebooks" })).toBeTruthy();
      expect(screen.getByText("Still checking your sign-in. Retry to check again.")).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Bring computation to life.")).toBeNull();
      const retry = screen.getByRole("button", { name: "Retry" });
      retry.focus();
      fireEvent.click(retry);
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("region", { name: "Notebook list" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(screen.getByText("Still checking your sign-in. Retry to check again.")).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("retries a failed cookie session check and keeps the heading for an empty list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, notebooks: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const readSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("Session service unavailable"))
      .mockResolvedValue({
        ok: true,
        session: { provider: "oidc", expires_at: 9_999_999_999, cache_key: "recovered" },
      });
    const store = new CloudAuthStore({ readAuthState: anonymousAuth });
    const dispose = store.activate(
      { authConfig, initialSession: null },
      { readAppSessionStatus: readSession },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("heading", { name: "Notebooks" })).toBeTruthy();
      expect(screen.getByText("Couldn't confirm your sign-in. Retry to check again.")).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Bring computation to life.")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { name: "Notebooks" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "No notebooks yet" })).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("region", { name: "Notebook list" }));
    } finally {
      dispose();
    }
  });

  it("keeps a dev-auth list request alive when an unrelated session check settles", async () => {
    let resolveSession!: (status: CloudAppSessionStatus) => void;
    const session = new Promise<CloudAppSessionStatus>((resolve) => {
      resolveSession = resolve;
    });
    let resolveList!: (response: Response) => void;
    const list = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const fetchMock = vi.fn(() => list);
    vi.stubGlobal("fetch", fetchMock);
    const store = new CloudAuthStore({
      readAuthState: () => ({
        mode: "dev",
        token: "test-token",
        user: "alice",
        oidcClaims: null,
        requestedScope: "owner",
        problem: null,
      }),
    });
    const dispose = store.activate(
      { authConfig, initialSession: null },
      { readAppSessionStatus: () => session },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveSession({ ok: true, session: null });
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveList(new Response(JSON.stringify({ ok: true, notebooks: [] })));
      });
      expect(screen.getByRole("heading", { name: "No notebooks yet" })).toBeTruthy();
    } finally {
      dispose();
    }
  });

  it("turns persistent app-session waits into a retryable list error", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "session unavailable" }), {
        headers: { "Content-Type": "application/json" },
        status: 503,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderNotebookList(oidcAuth("alice@example.test", { token: null }), {
      appSessionWaitDeadlineMs: 5,
    });

    expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Unable to list notebooks: session unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("waits for app-session confirmation before issuing the cookie-only list fetch", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          notebooks: [],
          current_user_principal: "user:anaconda:alice%40example.test",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderNotebookList(oidcAuth("alice@example.test"), { appSessionWaitDeadlineMs: 5_000 });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
  });

  it("loads as soon as the auth store confirms an app session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          notebooks: [notebook("nb-recovered", "Recovered Notebook")],
          current_user_principal: "user:anaconda:alice%40example.test",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = renderNotebookList(oidcAuth("alice@example.test"), {
      appSessionWaitDeadlineMs: 5_000,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();

    let dispose = () => {};
    await act(async () => {
      dispose = store.activate(
        {
          authConfig,
          initialSession: {
            provider: "oidc",
            expires_at: 99_999,
            cache_key: "session-a",
          },
        },
        { now: () => 0 },
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recovered Notebook")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    dispose();
  });

  it("renders the true total count and visible cap in the dashboard header", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          notebooks: [notebook("nb-a", "Notebook A"), notebook("nb-b", "Notebook B")],
          total_count: 342,
          current_user_principal: "user:anaconda:alice%40example.test",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = renderNotebookList(oidcAuth("alice@example.test"), {
      appSessionWaitDeadlineMs: 5_000,
    });

    let dispose = () => {};
    await act(async () => {
      dispose = store.activate(
        {
          authConfig,
          initialSession: {
            provider: "oidc",
            expires_at: 99_999,
            cache_key: "session-a",
          },
        },
        { now: () => 0 },
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("342 notebooks · showing 2 · 0 active now")).toBeTruthy();
    dispose();
  });

  it("shows the private session display name on a bootstrap-only server login", async () => {
    const session = { provider: "oidc" as const, expires_at: 99_999, cache_key: "session-a" };
    const bootstrap = document.createElement("script");
    bootstrap.id = "nteract-cloud-bootstrap";
    bootstrap.type = "application/json";
    bootstrap.textContent = JSON.stringify({
      kind: "notebook-list",
      saved_at: "2026-09-22T20:00:00Z",
      session,
      notebooks: [notebook("nb-a", "Notebook A")],
    });
    document.body.append(bootstrap);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            notebooks: [notebook("nb-a", "Notebook A")],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const serverConfig: CloudViewerAuthConfig = {
      localDev: null,
      oidc: {
        flow: "server",
        issuer: "https://issuer.test",
        clientId: "client-id",
        redirectUri: `${window.location.origin}/oidc`,
      },
    };
    const store = new CloudAuthStore({
      readAuthState: () => ({
        mode: "anonymous",
        token: null,
        user: null,
        oidcClaims: null,
        requestedScope: null,
        problem: null,
      }),
    });
    const readSession = vi.fn(async () => ({
      ok: true as const,
      session: { ...session, display_name: "Alice Example" },
    }));
    const dispose = store.activate(
      { authConfig: serverConfig, initialSession: session },
      { now: () => 0, readAppSessionStatus: readSession },
    );
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={serverConfig} />
        </CloudAuthStoreProvider>,
      );
      expect(screen.getByText("Notebook A")).toBeTruthy();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("by Alice")).toBeTruthy();
      const trigger = screen.getByRole("button", { name: "Alice Example" });
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
      expect(screen.getByRole("menu").textContent).toContain("Alice Example");
      expect(screen.queryByText("You")).toBeNull();
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalled();
      expect(storage.getItem("nteract:notebook-cloud:oidc-token")).toBeNull();
      expect(bootstrap.textContent).not.toContain("Alice Example");
    } finally {
      dispose();
      bootstrap.remove();
    }
  });

  it("keeps cached notebooks visible when revalidation fails", async () => {
    const auth = oidcAuth("alice@example.test");
    const cachedNotebooks = [notebook("nb-cached", "Cached Notebook")];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    writeCachedCloudNotebookList(storage, auth, null, cachedNotebooks, {
      principal: "user:anaconda:alice%40example.test",
    });

    renderNotebookList(auth, { appSessionWaitDeadlineMs: 5 });

    expect(screen.getByText("Cached Notebook")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Cached Notebook")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("notebook list refresh failed"),
      expect.any(Error),
    );
  });

  it("does not restore revoked bootstrap items when the session renews offline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = { provider: "oidc" as const, expires_at: 99_999, cache_key: "renewal-a" };
    const bootstrap = document.createElement("script");
    bootstrap.id = "nteract-cloud-bootstrap";
    bootstrap.type = "application/json";
    bootstrap.textContent = JSON.stringify({
      kind: "notebook-list",
      saved_at: "2026-09-24T12:00:00Z",
      session,
      notebooks: [notebook("revoked", "Revoked notebook")],
    });
    document.body.append(bootstrap);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, notebooks: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const store = new CloudAuthStore({
      readAuthState: () => ({
        mode: "anonymous",
        token: null,
        user: null,
        oidcClaims: null,
        requestedScope: null,
        problem: null,
      }),
    });
    const deps = { now: () => 0, readAppSessionStatus: () => new Promise<never>(() => {}) };
    let dispose = store.activate({ authConfig, initialSession: session }, deps);
    try {
      render(
        <CloudAuthStoreProvider store={store}>
          <CloudNotebookListView authConfig={authConfig} />
        </CloudAuthStoreProvider>,
      );
      expect(screen.getByText("Revoked notebook")).toBeTruthy();
      await act(async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      expect(screen.queryByText("Revoked notebook")).toBeNull();
      fetchMock.mockRejectedValue(new Error("offline"));
      await act(async () => {
        dispose();
        dispose = store.activate(
          { authConfig, initialSession: { ...session, expires_at: 199_999 } },
          deps,
        );
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(screen.queryByText("Revoked notebook")).toBeNull();
    } finally {
      dispose();
      bootstrap.remove();
    }
  });

  it("adds, renames, and removes notebooks from live notifications without navigation", async () => {
    const sockets: EventTarget[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          sockets.push(this);
        }
        send() {}
        close() {}
      },
    );
    let notebooks: CloudNotebookListItem[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, notebooks })));
    vi.stubGlobal("fetch", fetchMock);
    renderNotebookList({
      mode: "dev",
      token: "token",
      user: "alice",
      oidcClaims: null,
      requestedScope: "owner",
      problem: null,
    });
    const notify = async (event: string) => {
      await act(async () => {
        sockets
          .at(-1)!
          .dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event }) }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    };
    await notify("ready");
    notebooks = [notebook("new", "Created elsewhere")];
    await notify("changed");
    expect(screen.getByText("Created elsewhere")).toBeTruthy();
    notebooks = [notebook("new", "Renamed elsewhere")];
    await notify("changed");
    expect(screen.queryByText("Created elsewhere")).toBeNull();
    expect(screen.getByText("Renamed elsewhere")).toBeTruthy();
    notebooks = [];
    await notify("changed");
    expect(screen.queryByText("Renamed elsewhere")).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(window.location.pathname).toBe("/n");
  });
});

function renderNotebookList(
  authState: CloudPrototypeAuthState,
  options: { appSessionWaitDeadlineMs?: number } = {},
) {
  const store = new CloudAuthStore({ readAuthState: () => authState });
  render(
    <CloudAuthStoreProvider store={store}>
      <CloudNotebookListView
        appSessionWaitDeadlineMs={options.appSessionWaitDeadlineMs}
        authConfig={authConfig}
      />
    </CloudAuthStoreProvider>,
  );
  return store;
}

function oidcAuth(
  subject: string,
  overrides: Partial<Pick<CloudPrototypeAuthState, "token">> = {},
): CloudPrototypeAuthState {
  return {
    mode: "oidc",
    token: overrides.token === undefined ? "token" : overrides.token,
    user: subject,
    oidcClaims: {
      sub: subject,
    },
    requestedScope: "viewer",
    problem: null,
  };
}

function anonymousAuth(): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: null,
    problem: null,
  };
}

function notebook(id: string, title: string): CloudNotebookListItem {
  return {
    notebook_id: id,
    title,
    owner_principal: "user:anaconda:alice%40example.test",
    scope: "owner",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    latest_revision_id: null,
    viewer_url: `/n/${id}/notebook`,
    endpoints: {
      catalog: `/api/n/${id}`,
      acl: `/api/n/${id}/acl`,
      access_requests: `/api/n/${id}/access-requests`,
    },
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
