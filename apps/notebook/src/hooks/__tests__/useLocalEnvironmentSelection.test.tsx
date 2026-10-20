import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";
import { DirectTransport } from "../../../../../packages/runtimed/src/direct-transport";
import { NotebookClient } from "runtimed";
import { emitBroadcast } from "../../lib/notebook-frame-bus";
import { useLocalEnvironmentSelection } from "../useLocalEnvironmentSelection";
import { LocalEnvironmentSelector } from "@/components/environment";
import { createWasmHarness } from "../../../../../packages/runtimed/tests/wasm-harness";
import type { InstalledCondaPackageInventory, NotebookRequest } from "runtimed";

describe("useLocalEnvironmentSelection", () => {
  it("routes framed Owner notifications through real WASM and selects/applies without document mutation", async () => {
    const harness = await createWasmHarness("local-selection-ui");
    const subscription = harness.engine.broadcasts$.subscribe(emitBroadcast);
    const user = userEvent.setup();
    const environment = {
      id: "rankings",
      name: "rankings",
      prefix: "/Conda Envs/Rankings",
      python_path: "/Conda Envs/Rankings/bin/python",
      python_version: "3.12",
    };
    let selection = {
      revision: 0,
      selected: null as typeof environment | null,
      applied: null as typeof environment | null,
      applying: false,
    };
    const requests: NotebookRequest[] = [];
    harness.transport.requestHandler = async (request) => {
      const typed = request as NotebookRequest;
      requests.push(typed);
      if (typed.type === "list_conda_environments")
        return {
          result: "conda_environments",
          inventory: { environments: [environment], truncated: false, warnings: [] },
        };
      if (typed.type === "set_environment_selection")
        selection = { ...selection, revision: 1, selected: environment };
      if (typed.type === "apply_environment_selection")
        selection = { ...selection, revision: 3, applied: selection.selected };
      return { result: "environment_selection", selection };
    };
    const client = new NotebookClient({ transport: harness.transport });
    function EnvironmentSection() {
      const { state, store } = useLocalEnvironmentSelection({
        client,
        enabled: true,
        connectionGeneration: 1,
        connectionStatus$: harness.transport.connectionStatus$,
      });
      return (
        <LocalEnvironmentSelector
          {...state}
          available
          blocked={false}
          running={{ id: null, name: "uv managed", pythonVersion: null }}
          onSelect={(target) => store.setSelection(target)}
          onLoadInventory={(refresh) => store.loadInventory(refresh)}
          onRetrySelection={() => store.refreshSelection()}
          onApply={(revision) =>
            store.apply(revision, harness.client.get_heads_hex(), store.generation)
          }
        />
      );
    }
    try {
      await harness.startAndCompleteSync();
      const heads = harness.client.get_heads_hex();
      const view = render(<EnvironmentSection />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toBeEnabled());
      expect(requests).toEqual([{ type: "get_environment_selection" }]);
      await user.click(screen.getByRole("button", { name: "Change" }));
      await user.click(await screen.findByRole("button", { name: /rankings \(Python 3.12\)/ }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Apply and restart" })).toBeEnabled(),
      );
      expect(screen.getByText("uv managed")).toBeVisible();
      expect(requests.map((request) => request.type)).toEqual([
        "get_environment_selection",
        "list_conda_environments",
        "set_environment_selection",
      ]);
      await user.click(screen.getByRole("button", { name: "Apply and restart" }));
      await waitFor(() => expect(requests.at(-1)?.type).toBe("apply_environment_selection"));
      expect(requests.at(-1)).toEqual({
        type: "apply_environment_selection",
        expected_revision: 1,
        observed_heads: heads,
      });
      act(() =>
        harness.transport.pushBroadcast({
          event: "environment_selection_changed",
          selection: { revision: 4, selected: null, applied: environment, applying: false },
        }),
      );
      expect(screen.getByText("Selected for next start").nextElementSibling).toHaveTextContent(
        "Automatic",
      );
      expect(harness.client.get_heads_hex()).toEqual(heads);
      view.unmount();
    } finally {
      subscription.unsubscribe();
      harness.dispose();
    }
  });

  it("uses the real client/store, gates old daemons, and refetches after a repeated attachment", async () => {
    const transport = new DirectTransport({
      flush_local_changes: () => null,
      receive_sync_message: () => false,
      reset_sync_state: () => {},
    });
    const requests: unknown[] = [];
    let revision = 1;
    transport.requestHandler = async (request) => {
      requests.push(request);
      return {
        result: "environment_selection",
        selection: { revision, selected: null, applied: null, applying: false },
      };
    };
    const client = new NotebookClient({ transport });
    const { result, rerender, unmount } = renderHook(
      ({ enabled, generation }) =>
        useLocalEnvironmentSelection({
          client,
          enabled,
          connectionGeneration: generation,
          connectionStatus$: transport.connectionStatus$,
        }),
      { initialProps: { enabled: false, generation: 1 } },
    );
    expect(requests).toEqual([]);
    rerender({ enabled: true, generation: 1 });
    await waitFor(() => expect(result.current.state.selection?.revision).toBe(1));
    act(() =>
      emitBroadcast({
        event: "environment_selection_changed",
        selection: { revision: 3, selected: null, applied: null, applying: false },
      }),
    );
    expect(result.current.state.selection?.revision).toBe(3);
    revision = 0;
    rerender({ enabled: true, generation: 2 });
    await waitFor(() => expect(result.current.state.selection?.revision).toBe(0));
    expect(requests).toEqual([
      { type: "get_environment_selection" },
      { type: "get_environment_selection" },
    ]);
    act(() => transport.disconnect());
    expect(result.current.state.selection).toBeNull();
    act(() => transport.reconnect());
    expect(result.current.state.selection).toBeNull();
    expect(requests).toHaveLength(2);
    rerender({ enabled: true, generation: 3 });
    await waitFor(() => expect(result.current.state.selection?.revision).toBe(0));
    expect(requests).toHaveLength(3);
    rerender({ enabled: false, generation: 3 });
    expect(result.current.state.selection).toBeNull();
    unmount();
  });

  it("clears installed package records when the runtime connection is replaced", async () => {
    const transport = new DirectTransport({
      flush_local_changes: () => null,
      receive_sync_message: () => false,
      reset_sync_state: () => {},
    });
    transport.requestHandler = async (request) => {
      if ((request as NotebookRequest).type === "list_installed_conda_packages") {
        return { result: "installed_conda_packages", inventory };
      }
      return {
        result: "environment_selection",
        selection: { revision: 1, selected: null, applied: null, applying: false },
      };
    };
    const client = new NotebookClient({ transport });
    const { result, rerender, unmount } = renderHook(
      ({ generation }) =>
        useLocalEnvironmentSelection({
          client,
          enabled: true,
          connectionGeneration: generation,
          connectionStatus$: transport.connectionStatus$,
        }),
      { initialProps: { generation: 1 } },
    );
    await waitFor(() => expect(result.current.state.selection).not.toBeNull());
    const inventory: InstalledCondaPackageInventory = {
      packages: [{ name: "numpy", version: "2.1.0", build: "py312_0" }],
      truncated: false,
      warnings: [],
    };
    await act(async () => {
      await result.current.store.loadInstalledPackages(false);
    });
    expect(result.current.state.installedPackages).toEqual(inventory);
    rerender({ generation: 2 });
    expect(result.current.state.installedPackages).toBeNull();
    unmount();
  });
});
