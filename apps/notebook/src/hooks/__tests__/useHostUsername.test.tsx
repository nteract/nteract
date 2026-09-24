import { NotebookHostProvider } from "@nteract/notebook-host";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureNotebookHost } from "../../../../elements/components/fixture-notebook-host";
import { useHostUsername } from "../useHostUsername";

function deferredUsername() {
  let resolve!: (username: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderUsername(getUsername: () => Promise<string>) {
  let host = createFixtureNotebookHost();
  host.system.getUsername = getUsername;
  const hook = renderHook(() => useHostUsername(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NotebookHostProvider host={host}>{children}</NotebookHostProvider>
    ),
  });
  return {
    ...hook,
    replaceHost(nextGetUsername: () => Promise<string>) {
      host = createFixtureNotebookHost();
      host.system.getUsername = nextGetUsername;
      hook.rerender();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useHostUsername", () => {
  it("uses the host without a Tauri username global and updates after a delayed reply", async () => {
    vi.stubGlobal("__NTERACT_USERNAME__", undefined);
    const username = deferredUsername();
    const getUsername = vi.fn(() => username.promise);
    const { result, rerender } = renderUsername(getUsername);

    expect(result.current).toBe("");
    await act(async () => username.resolve("  Ada Lovelace  "));
    expect(result.current).toBe("Ada Lovelace");
    rerender();
    expect(getUsername).toHaveBeenCalledTimes(1);
  });

  it("uses the active host even when a different native username global exists", async () => {
    vi.stubGlobal("__NTERACT_USERNAME__", "Previous native user");
    const { result } = renderUsername(async () => "Current host user");
    await act(async () => {});
    expect(result.current).toBe("Current host user");
  });

  it.each(["", "   "])("keeps the empty-label fallback for %j", async (username) => {
    const { result } = renderUsername(async () => username);
    await act(async () => {});
    expect(result.current).toBe("");
  });

  it("keeps the empty-label fallback when lookup fails", async () => {
    const { result } = renderUsername(async () => {
      throw new Error("Host unavailable");
    });
    await act(async () => {});
    expect(result.current).toBe("");
  });

  it("clears the previous host's name while a replacement lookup is pending", async () => {
    const { result, replaceHost } = renderUsername(async () => "First user");
    await act(async () => {});
    expect(result.current).toBe("First user");

    const next = deferredUsername();
    replaceHost(() => next.promise);
    expect(result.current).toBe("");
    await act(async () => next.resolve("Next user"));
    expect(result.current).toBe("Next user");
  });

  it("ignores a superseded host's late reply", async () => {
    const previous = deferredUsername();
    const { result, replaceHost } = renderUsername(() => previous.promise);
    replaceHost(async () => "Current user");
    await act(async () => {});
    expect(result.current).toBe("Current user");
    await act(async () => previous.resolve("Previous user"));
    expect(result.current).toBe("Current user");
  });

  it("ignores a reply after unmount", async () => {
    const username = deferredUsername();
    const { result, unmount } = renderUsername(() => username.promise);
    unmount();
    await act(async () => username.resolve("Late user"));
    expect(result.current).toBe("");
  });
});
