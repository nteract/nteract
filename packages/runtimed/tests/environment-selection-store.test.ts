import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";
import { DirectTransport } from "../src/direct-transport";
import { NotebookClient } from "../src/notebook-client";
import { EnvironmentSelectionStore } from "../src/environment-selection-store";
import type { EnvironmentSelectionSnapshot, NotebookRequest } from "../src/request-types";

const rankings = {
  id: "conda:rankings",
  name: "rankings",
  prefix: "/envs/Rankings Env",
  python_path: "/envs/Rankings Env/bin/python",
  python_version: "3.12",
};

function selection(
  revision: number,
  selected: typeof rankings | null = rankings,
  applied: typeof rankings | null = null,
  applying = false,
): EnvironmentSelectionSnapshot {
  return { revision, selected, applied, applying };
}

function setup() {
  const transport = new DirectTransport({
    flush_local_changes: () => null,
    receive_sync_message: () => false,
    reset_sync_state: () => {},
  });
  const requests: NotebookRequest[] = [];
  transport.requestHandler = async (request) => {
    requests.push(request as NotebookRequest);
    return { result: "environment_selection", selection: selection(1) };
  };
  const client = new NotebookClient({ transport });
  const broadcasts = new Subject<unknown>();
  const store = new EnvironmentSelectionStore();
  return { transport, client, broadcasts, store, requests };
}

describe("EnvironmentSelectionStore", () => {
  it("does not let a late failed read replace a newer authoritative selection with an error", async () => {
    const { store, client, broadcasts, transport } = setup();
    let resolve!: (response: unknown) => void;
    transport.requestHandler = () =>
      new Promise((done) => {
        resolve = done;
      });
    store.activate({ client, broadcasts$: broadcasts });
    broadcasts.next({ event: "environment_selection_changed", selection: selection(4) });
    resolve({ result: "error", error: "Old request failed" });
    await vi.waitFor(() => expect(store.snapshot.loadingSelection).toBe(false));
    expect(store.snapshot.error).toBeNull();
    expect(store.snapshot.selection?.revision).toBe(4);
    store.dispose();
  });

  it("discards an inventory response superseded by a later refresh", async () => {
    const { store, client, broadcasts, transport } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    const replies: Array<(response: unknown) => void> = [];
    transport.requestHandler = () => new Promise((done) => replies.push(done));
    const first = store.loadInventory(false);
    const second = store.loadInventory(true);
    const current = { environments: [rankings], truncated: false, warnings: [] };
    replies[1]({ result: "conda_environments", inventory: current });
    await second;
    replies[0]({
      result: "conda_environments",
      inventory: { environments: [], truncated: true, warnings: ["old"] },
    });
    await first;
    expect(store.snapshot.inventory).toEqual(current);
    store.dispose();
  });

  it("refreshes the authoritative snapshot after a stale Apply rejection", async () => {
    const { store, client, broadcasts, transport, requests } = setup();
    transport.requestHandler = async (request) => {
      const notebookRequest = request as NotebookRequest;
      requests.push(notebookRequest);
      return notebookRequest.type === "list_installed_conda_packages"
        ? {
            result: "installed_conda_packages",
            inventory: { packages: [], truncated: false, warnings: [] },
          }
        : { result: "environment_selection", selection: selection(1) };
    };
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    transport.requestHandler = async (request) => {
      requests.push(request as NotebookRequest);
      return (request as NotebookRequest).type === "apply_environment_selection"
        ? { result: "environment_selection_rejected", error: "Another owner changed selection" }
        : { result: "environment_selection", selection: selection(4) };
    };
    const response = await store.apply(1, ["head-a"], store.generation);
    expect(response.result).toBe("environment_selection_rejected");
    expect(store.snapshot.selection?.revision).toBe(4);
    expect(store.snapshot.error).toBe("Another owner changed selection");
    expect(requests[1]).toEqual({
      type: "apply_environment_selection",
      expected_revision: 1,
      observed_heads: ["head-a"],
    });
    store.dispose();
  });

  it("hydrates selection without discovering environments and mirrors owner notifications", async () => {
    const { store, client, broadcasts, requests } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection?.revision).toBe(1));
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    broadcasts.next({ event: "environment_selection_changed", selection: selection(3) });
    broadcasts.next({ event: "environment_selection_changed", selection: selection(2) });
    expect(store.snapshot.selection?.revision).toBe(3);
    store.dispose();
  });

  it("discards a read when a newer notification arrives", async () => {
    const { store, client, broadcasts, transport } = setup();
    let resolve!: (response: unknown) => void;
    transport.requestHandler = () =>
      new Promise((done) => {
        resolve = done;
      });
    store.activate({ client, broadcasts$: broadcasts });
    broadcasts.next({ event: "environment_selection_changed", selection: selection(4) });
    resolve({ result: "environment_selection", selection: selection(1) });
    await vi.waitFor(() => expect(store.snapshot.loadingSelection).toBe(false));
    expect(store.snapshot.selection?.revision).toBe(4);
    store.dispose();
  });

  it("does not apply responses from a disposed attachment to its replacement", async () => {
    const { store, client, broadcasts, transport } = setup();
    let resolveOld!: (response: unknown) => void;
    transport.requestHandler = () =>
      new Promise((done) => {
        resolveOld = done;
      });
    store.activate({ client, broadcasts$: broadcasts });
    store.dispose();
    transport.requestHandler = async () => ({
      result: "environment_selection",
      selection: selection(2),
    });
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection?.revision).toBe(2));
    resolveOld({ result: "environment_selection", selection: selection(99) });
    await Promise.resolve();
    expect(store.snapshot.selection?.revision).toBe(2);
    store.dispose();
  });

  it("loads inventory on demand, keeps errors visible, and recovers with Refresh", async () => {
    const { store, client, broadcasts, transport, requests } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    transport.requestHandler = async (request) => {
      requests.push(request as NotebookRequest);
      return { result: "error", error: "Registry unavailable" };
    };
    await store.loadInventory(false);
    expect(store.snapshot.error).toBe("Registry unavailable");
    transport.requestHandler = async (request) => {
      requests.push(request as NotebookRequest);
      return {
        result: "conda_environments",
        inventory: { environments: [rankings], truncated: false, warnings: [] },
      };
    };
    await store.loadInventory(true);
    expect(store.snapshot.inventory?.environments).toEqual([rankings]);
    expect(store.snapshot.error).toBeNull();
    expect(requests.slice(1)).toEqual([
      { type: "list_conda_environments", refresh: false },
      { type: "list_conda_environments", refresh: true },
    ]);
    store.dispose();
  });

  it("loads installed records separately and discards a late inventory response", async () => {
    const { store, client, broadcasts, transport, requests } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    const replies: Array<(response: unknown) => void> = [];
    transport.requestHandler = (request) => {
      requests.push(request as NotebookRequest);
      expect((request as NotebookRequest).type).toBe("list_installed_conda_packages");
      return new Promise((done) => replies.push(done));
    };
    const first = store.loadInstalledPackages(false);
    const second = store.loadInstalledPackages(true);
    const current = {
      packages: [{ name: "numpy", version: "2.1.0", build: "py312_0" }],
      truncated: false,
      warnings: [],
    };
    replies[1]({ result: "installed_conda_packages", inventory: current });
    await second;
    replies[0]({ result: "installed_conda_packages", inventory: { ...current, packages: [] } });
    await first;
    expect(store.snapshot.installedPackages).toEqual(current);
    expect(requests).toContainEqual({ type: "list_installed_conda_packages", refresh: true });
    store.dispose();
  });

  it("loads inventory only after the selected Conda target is applied", async () => {
    const { store, client, broadcasts, transport, requests } = setup();
    transport.requestHandler = async (request) => {
      requests.push(request as NotebookRequest);
      return (request as NotebookRequest).type === "get_environment_selection"
        ? { result: "environment_selection", selection: selection(1) }
        : {
            result: "installed_conda_packages",
            inventory: { packages: [], truncated: false, warnings: [] },
          };
    };
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    await store.loadInstalledPackagesForRunningEnvironment(null, false);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    broadcasts.next({
      event: "environment_selection_changed",
      selection: selection(2, rankings, rankings),
    });
    await store.loadInstalledPackagesForRunningEnvironment(rankings.id, true);
    expect(requests.at(-1)).toEqual({ type: "list_installed_conda_packages", refresh: false });
    store.dispose();
  });

  it("does not inventory while Automatic, targets differ, or apply is in progress", async () => {
    const { store, client, broadcasts, requests } = setup();
    const transport = (
      client as unknown as {
        transport: { requestHandler: (request: NotebookRequest) => Promise<unknown> };
      }
    ).transport;
    transport.requestHandler = async (request) => {
      requests.push(request);
      return { result: "environment_selection", selection: selection(1) };
    };
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    await store.loadInstalledPackagesForRunningEnvironment(rankings.id, true);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    broadcasts.next({
      event: "environment_selection_changed",
      selection: selection(2, null, null),
    });
    await store.loadInstalledPackagesForRunningEnvironment(rankings.id, true);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    broadcasts.next({
      event: "environment_selection_changed",
      selection: selection(3, rankings, rankings),
    });
    await store.loadInstalledPackagesForRunningEnvironment("conda:other", true);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    broadcasts.next({
      event: "environment_selection_changed",
      selection: selection(4, rankings, rankings, true),
    });
    await store.loadInstalledPackagesForRunningEnvironment(rankings.id, true);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    store.dispose();
  });

  it("requires the selected, applied, and running Conda identities to match", async () => {
    const { store, client, broadcasts, transport, requests } = setup();
    transport.requestHandler = async (request) => {
      requests.push(request as NotebookRequest);
      return (request as NotebookRequest).type === "get_environment_selection"
        ? { result: "environment_selection", selection: selection(1) }
        : {
            result: "installed_conda_packages",
            inventory: { packages: [], truncated: false, warnings: [] },
          };
    };
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());

    broadcasts.next({
      event: "environment_selection_changed",
      selection: selection(2, rankings, rankings),
    });
    await store.loadInstalledPackagesForRunningEnvironment("conda:other", true);
    expect(requests).toEqual([{ type: "get_environment_selection" }]);

    await store.loadInstalledPackagesForRunningEnvironment(rankings.id, true);
    expect(requests.at(-1)).toEqual({ type: "list_installed_conda_packages", refresh: false });
    store.dispose();
  });

  it("never carries installed-package records across runtime session replacement", async () => {
    const { store, client, broadcasts, transport } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    const replies: Array<(response: unknown) => void> = [];
    transport.requestHandler = () => new Promise((resolve) => replies.push(resolve));
    const request = store.loadInstalledPackages(false);
    expect(replies).toHaveLength(1);
    store.dispose();
    store.activate({ client, broadcasts$: broadcasts });
    replies[0]({
      result: "installed_conda_packages",
      inventory: {
        packages: [{ name: "numpy", version: "2", build: "0" }],
        truncated: false,
        warnings: [],
      },
    });
    await request;
    expect(store.snapshot.installedPackages).toBeNull();
    store.dispose();
  });

  it("preserves the server snapshot while a selection write is in flight", async () => {
    const { store, client, broadcasts, transport } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    let resolve!: (response: unknown) => void;
    transport.requestHandler = () =>
      new Promise((done) => {
        resolve = done;
      });
    const selecting = store.setSelection({ kind: "automatic" });
    expect(store.snapshot.selection?.selected).toEqual(rankings);
    expect(store.snapshot.mutating).toBe(true);
    resolve({
      result: "environment_selection",
      selection: { revision: 2, selected: null, applied: null, applying: false },
    });
    await selecting;
    expect(store.snapshot.selection?.selected).toBeNull();
    expect(store.snapshot.mutating).toBe(false);
    store.dispose();
  });

  it("rejects an apply captured for an earlier connection without sending it", async () => {
    const { store, client, broadcasts, requests } = setup();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    const generation = store.generation;
    store.dispose();
    store.activate({ client, broadcasts$: broadcasts });
    await vi.waitFor(() => expect(store.snapshot.selection).not.toBeNull());
    const response = await store.apply(1, ["head-a"], generation);
    expect(response.result).toBe("environment_selection_rejected");
    expect(requests.every((request) => request.type === "get_environment_selection")).toBe(true);
    store.dispose();
  });
});
