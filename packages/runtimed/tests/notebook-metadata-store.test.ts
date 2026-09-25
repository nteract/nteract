import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookMetadataStore } from "../src/notebook-metadata-store";

function handle(value: object, fingerprint = "same") {
  return {
    get_metadata_fingerprint: () => fingerprint,
    get_metadata_snapshot: vi.fn(() => value),
  };
}

describe("NotebookMetadataStore", () => {
  it("keeps snapshot identity and skips reads/notifications for unrelated sync", () => {
    const store = new NotebookMetadataStore();
    const source = handle({ runt: { uv: { dependencies: ["numpy"] } } });
    const notify = vi.fn();
    const stop = store.subscribe(notify);
    store.refresh(source);
    const snapshot = store.getSnapshot();
    store.refresh(source);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(source.get_metadata_snapshot).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
    store.reset();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reads a replacement handle even when its fingerprint matches", () => {
    const store = new NotebookMetadataStore();
    store.refresh(handle({ title: "first" }));
    store.refresh(handle({ title: "second" }));
    expect(store.getSnapshot()).toEqual({ title: "second" });
  });

  it("lets live metadata supersede fallback once, including reconnect and notebook reset", () => {
    const store = new NotebookMetadataStore();
    const live = handle({ title: "live" });
    store.acceptSnapshot({ title: "cached" });
    expect(store.getSnapshot()).toEqual({ title: "cached" });
    store.refresh(live);
    store.acceptSnapshot({ title: "late cached" });
    expect(store.getSnapshot()).toEqual({ title: "live" });
    store.detach(live);
    store.acceptSnapshot({ title: "old during reconnect" });
    expect(store.getSnapshot()).toEqual({ title: "live" });
    store.refresh(handle({ title: "reconnected" }));
    store.detach(live);
    store.acceptSnapshot({ title: "stale teardown" });
    expect(store.getSnapshot()).toEqual({ title: "reconnected" });
    store.reset();
    expect(store.getSnapshot()).toBeNull();
    store.acceptSnapshot({ title: "next notebook" });
    expect(store.getSnapshot()).toEqual({ title: "next notebook" });
  });
});
