import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSyncedSettings } from "../useSyncedSettings";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSyncedSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    localStorage.clear();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockResolvedValue(() => {});
  });

  afterEach(() => {
    delete (window as Partial<Window> & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    localStorage.clear();
  });

  it("ignores initial daemon settings that resolve after unmount", async () => {
    const load = deferred<unknown>();
    mocks.invoke.mockReturnValue(load.promise);

    const { unmount } = renderHook(() => useSyncedSettings());

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("get_synced_settings", undefined);
    });

    unmount();

    await act(async () => {
      load.resolve({ color_theme: "cream", theme: "dark" });
      await load.promise;
    });

    expect(localStorage.getItem("notebook-theme")).toBeNull();
    expect(localStorage.getItem("notebook-color-theme")).toBeNull();
  });

  it("ignores settings events after unmount while listener teardown is pending", async () => {
    const listenReady = deferred<() => void>();
    const unlisten = vi.fn();
    let handler: ((event: { payload: unknown }) => void) | undefined;
    mocks.invoke.mockResolvedValue({});
    mocks.listen.mockImplementation((_eventName, eventHandler) => {
      handler = eventHandler;
      return listenReady.promise;
    });

    const { unmount } = renderHook(() => useSyncedSettings());

    await waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledWith("settings:changed", expect.any(Function));
    });

    unmount();

    act(() => {
      handler?.({ payload: { color_theme: "cream", theme: "dark" } });
    });

    expect(localStorage.getItem("notebook-theme")).toBeNull();
    expect(localStorage.getItem("notebook-color-theme")).toBeNull();

    await act(async () => {
      listenReady.resolve(unlisten);
      await listenReady.promise;
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
