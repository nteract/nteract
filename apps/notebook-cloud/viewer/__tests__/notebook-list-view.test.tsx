import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudAuthStoreProvider } from "../cloud-auth-context";
import { CloudAuthStore } from "../cloud-auth-store";
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

  it("starts the list fetch with OIDC credentials before app-session establishment settles", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No notebooks yet")).toBeTruthy();
  });

  it("keeps a provisional OIDC 401 quiet while the app-session fallback catches up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "sign in to list notebooks" }), {
          headers: { "Content-Type": "application/json" },
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
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

    renderNotebookList(oidcAuth("alice@example.test"), { appSessionWaitDeadlineMs: 5 });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "Loading notebooks" })).toBeTruthy();
    expect(screen.queryByText(/sign in to list notebooks/i)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Recovered Notebook")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
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

    renderNotebookList(oidcAuth("alice@example.test"), { appSessionWaitDeadlineMs: 5_000 });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("342 notebooks · showing 2 · 0 active now")).toBeTruthy();
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
