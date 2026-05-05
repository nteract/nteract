import { describe, expect, it, vi } from "vite-plus/test";

import { NotebookHandleHost, type HostedNotebookHandle, type NotebookHandleSlot } from "../src";

function createHandle(name: string, calls: string[]): HostedNotebookHandle {
  return {
    free: vi.fn(() => calls.push(`free:${name}`)),
    set_blob_port: vi.fn((port: number) => calls.push(`blob:${name}:${port}`)),
    set_mime_priority: vi.fn(() => calls.push(`mime:${name}`)),
  };
}

describe("NotebookHandleHost", () => {
  it("clears published handle before freeing a replaced handle", async () => {
    const calls: string[] = [];
    const previousHandle = createHandle("previous", calls);
    const nextHandle = createHandle("next", calls);
    const slot: NotebookHandleSlot = { current: previousHandle };

    const host = new NotebookHandleHost({
      actorLabel: () => "human:test",
      createHandle: vi.fn(() => nextHandle),
      getBlobPort: vi.fn(() => 42),
      publishHandle: vi.fn((handle) => calls.push(handle ? "publish:next" : "publish:null")),
      refreshBlobPort: vi.fn(),
      slot,
    });

    await expect(host.bootstrap()).resolves.toBe(true);

    expect(calls).toEqual([
      "publish:null",
      "free:previous",
      "mime:next",
      "blob:next:42",
      "publish:next",
    ]);
    expect(slot.current).toBe(nextHandle);
  });

  it("frees an unpublished handle when bootstrap is cancelled during blob-port refresh", async () => {
    const calls: string[] = [];
    let cancelled = false;
    let resolveBlobPort: (port: number | null) => void = () => {};
    const handle = createHandle("next", calls);
    const slot: NotebookHandleSlot = { current: null };
    const publishHandle = vi.fn((publishedHandle) =>
      calls.push(publishedHandle ? "publish:next" : "publish:null"),
    );

    const host = new NotebookHandleHost({
      actorLabel: () => "human:test",
      createHandle: vi.fn(() => handle),
      getBlobPort: vi.fn(() => null),
      publishHandle,
      refreshBlobPort: vi.fn(
        () =>
          new Promise<number | null>((resolve) => {
            resolveBlobPort = resolve;
          }),
      ),
      slot,
    });

    const bootstrap = host.bootstrap(() => cancelled);
    await Promise.resolve();
    cancelled = true;
    resolveBlobPort(42);

    await expect(bootstrap).resolves.toBe(false);
    expect(calls).toEqual(["publish:null", "mime:next", "publish:null", "free:next"]);
    expect(slot.current).toBeNull();
    expect(publishHandle).not.toHaveBeenCalledWith(handle);
  });

  it("clear publishes null before freeing the current handle", () => {
    const calls: string[] = [];
    const handle = createHandle("current", calls);
    const slot: NotebookHandleSlot = { current: handle };

    const host = new NotebookHandleHost({
      actorLabel: () => "human:test",
      createHandle: vi.fn(() => createHandle("next", calls)),
      publishHandle: vi.fn((publishedHandle) =>
        calls.push(publishedHandle ? "publish:next" : "publish:null"),
      ),
      slot,
    });

    host.clear();

    expect(calls).toEqual(["publish:null", "free:current"]);
    expect(slot.current).toBeNull();
  });

  it("does not clear a newer bootstrap that replaces it during blob-port refresh", async () => {
    const calls: string[] = [];
    const blobPortResolvers: Array<(port: number | null) => void> = [];
    const pendingHandle = createHandle("pending", calls);
    const replacementHandle = createHandle("replacement", calls);
    const slot: NotebookHandleSlot = { current: null };
    const publishHandle = vi.fn((publishedHandle) => {
      if (publishedHandle === pendingHandle) calls.push("publish:pending");
      else if (publishedHandle === replacementHandle) calls.push("publish:replacement");
      else calls.push("publish:null");
    });
    const handles = [pendingHandle, replacementHandle];

    const host = new NotebookHandleHost({
      actorLabel: () => "human:test",
      createHandle: vi.fn(() => handles.shift() ?? createHandle("unexpected", calls)),
      getBlobPort: vi.fn(() => null),
      publishHandle,
      refreshBlobPort: vi.fn(
        () =>
          new Promise<number | null>((resolve) => {
            blobPortResolvers.push(resolve);
          }),
      ),
      slot,
    });

    const firstBootstrap = host.bootstrap();
    await Promise.resolve();
    const secondBootstrap = host.bootstrap();
    await Promise.resolve();
    blobPortResolvers[0](42);

    await expect(firstBootstrap).resolves.toBe(false);
    expect(slot.current).toBe(replacementHandle);
    expect(publishHandle).not.toHaveBeenCalledWith(pendingHandle);
    expect(pendingHandle.free).toHaveBeenCalledTimes(1);
    expect(replacementHandle.free).not.toHaveBeenCalled();

    blobPortResolvers[1](43);
    await expect(secondBootstrap).resolves.toBe(true);

    expect(calls).toEqual([
      "publish:null",
      "mime:pending",
      "publish:null",
      "free:pending",
      "mime:replacement",
      "blob:replacement:43",
      "publish:replacement",
    ]);
  });
});
