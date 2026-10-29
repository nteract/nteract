import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import {
  getOutputSessionHostMethods,
  getOutputSessionPluginForMethod,
  getOutputSessionPlugins,
  OutputSessionBridges,
  outputSessionBindings,
  registerOutputSessionPlugin,
  type OutputSessionBridge,
  type OutputSessionPlugin,
} from "../output-session-plugins";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function display(outputId: string, data: Record<string, unknown>): JupyterOutput {
  return { output_id: outputId, output_type: "display_data", data, metadata: {} };
}

function fakeBridge(): OutputSessionBridge {
  return {
    setBindings: vi.fn(),
    updateRuntime: vi.fn(),
    handleRequest: vi.fn(async () => "ok"),
    notifyCurrentState: vi.fn(),
    dispose: vi.fn(),
  };
}

function plugin(
  id: string,
  mimeType: string,
  hostMethods: string[],
  createBridge: OutputSessionPlugin<string>["createBridge"] = () => fakeBridge(),
): OutputSessionPlugin<string> {
  return {
    id,
    mimeTypes: [mimeType],
    hostMethods,
    bindings: vi.fn((outputs: readonly JupyterOutput[]) =>
      outputs.flatMap((output) =>
        output.output_id && output.output_type === "display_data" && mimeType in output.data
          ? [output.output_id]
          : [],
      ),
    ),
    createBridge: vi.fn(createBridge),
  };
}

function register<B, R>(entry: OutputSessionPlugin<B, R>): void {
  cleanups.push(registerOutputSessionPlugin(entry));
}

const frame = {} as IsolatedFrameHandle;

describe("output-session plugin registry", () => {
  it("selects plugins by the MIME types present in the outputs", () => {
    const alpha = plugin("alpha", "application/x-alpha", ["alpha/open"]);
    const beta = plugin("beta", "application/x-beta", ["beta/open"]);
    register(alpha);
    register(beta);

    const bindings = outputSessionBindings([
      display("a1", { "application/x-alpha": {}, "text/plain": "a" }),
      { output_type: "stream", name: "stdout", text: "application/x-beta" },
      display("p1", { "text/plain": "plain" }),
    ]);

    expect([...bindings.keys()]).toEqual(["alpha"]);
    expect(bindings.get("alpha")).toEqual({ plugin: alpha, bindings: ["a1"] });
    expect(beta.bindings).not.toHaveBeenCalled();
  });

  it("omits plugins whose MIME is present but which produce no bindings", () => {
    const alpha = plugin("alpha", "application/x-alpha", []);
    register(alpha);

    const bindings = outputSessionBindings([
      { output_type: "display_data", data: { "application/x-alpha": {} } },
    ]);

    expect(bindings.size).toBe(0);
    expect(alpha.bindings).toHaveBeenCalledOnce();
  });

  it("routes host methods to the plugin that declares them", () => {
    const alpha = plugin("alpha", "application/x-alpha", ["alpha/open", "alpha/patch"]);
    register(alpha);

    expect(getOutputSessionHostMethods()).toEqual(["alpha/open", "alpha/patch"]);
    expect(getOutputSessionPluginForMethod("alpha/patch")).toBe(alpha);
    expect(getOutputSessionPluginForMethod("beta/open")).toBeNull();
  });

  it("rejects a host method already served by another plugin", () => {
    register(plugin("alpha", "application/x-alpha", ["shared/open"]));

    expect(() =>
      registerOutputSessionPlugin(plugin("beta", "application/x-beta", ["shared/open"])),
    ).toThrow(
      'Output session plugin "beta" claims host method shared/open, already served by "alpha"',
    );
  });

  it("keeps snapshots stable when the same plugin is installed again and drops it on unregister", () => {
    const alpha = plugin("alpha", "application/x-alpha", ["alpha/open"]);
    const unregister = registerOutputSessionPlugin(alpha);
    const plugins = getOutputSessionPlugins();
    const methods = getOutputSessionHostMethods();

    registerOutputSessionPlugin(alpha);
    expect(getOutputSessionPlugins()).toBe(plugins);
    expect(getOutputSessionHostMethods()).toBe(methods);

    unregister();
    expect(getOutputSessionPlugins()).toEqual([]);
    expect(getOutputSessionHostMethods()).toEqual([]);
  });
});

describe("OutputSessionBridges", () => {
  it("creates one bridge per plugin lazily and updates it on later syncs", () => {
    const bridge = fakeBridge();
    const alpha = plugin("alpha", "application/x-alpha", ["alpha/open"], () => bridge);
    register(alpha);
    const bridges = new OutputSessionBridges();
    const runtime = { epoch: 1 };
    const nextRuntime = { epoch: 2 };

    bridges.sync(frame, outputSessionBindings([display("a1", { "application/x-alpha": {} })]), {
      alpha: runtime,
    });
    bridges.sync(
      frame,
      outputSessionBindings([
        display("a1", { "application/x-alpha": {} }),
        display("a2", { "application/x-alpha": {} }),
      ]),
      { alpha: nextRuntime },
    );

    expect(alpha.createBridge).toHaveBeenCalledOnce();
    expect(alpha.createBridge).toHaveBeenCalledWith({ frame, runtime, bindings: ["a1"] });
    expect(bridge.setBindings).toHaveBeenCalledWith(["a1", "a2"]);
    expect(bridge.updateRuntime).toHaveBeenNthCalledWith(1, runtime);
    expect(bridge.updateRuntime).toHaveBeenNthCalledWith(2, nextRuntime);
  });

  it("disposes a bridge when its runtime, bindings or frame go away", () => {
    const created: OutputSessionBridge[] = [];
    register(
      plugin("alpha", "application/x-alpha", ["alpha/open"], () => {
        const bridge = fakeBridge();
        created.push(bridge);
        return bridge;
      }),
    );
    const bindings = outputSessionBindings([display("a1", { "application/x-alpha": {} })]);
    const bridges = new OutputSessionBridges();

    bridges.sync(frame, bindings, { alpha: {} });
    bridges.sync(frame, bindings, {});
    bridges.sync(frame, bindings, { alpha: {} });
    bridges.sync(frame, new Map(), { alpha: {} });
    bridges.sync(frame, bindings, { alpha: {} });
    bridges.sync(null, bindings, { alpha: {} });

    expect(created).toHaveLength(3);
    for (const bridge of created) expect(bridge.dispose).toHaveBeenCalledOnce();
  });

  it("routes requests to the active bridge and rejects unknown or inactive methods", async () => {
    const bridge = fakeBridge();
    register(plugin("alpha", "application/x-alpha", ["alpha/open"], () => bridge));
    register(plugin("beta", "application/x-beta", ["beta/open"], () => null));
    const bridges = new OutputSessionBridges();
    bridges.sync(
      frame,
      outputSessionBindings([
        display("a1", { "application/x-alpha": {} }),
        display("b1", { "application/x-beta": {} }),
      ]),
      { alpha: {}, beta: {} },
    );

    await expect(bridges.handleRequest("alpha/open", { id: 1 })).resolves.toBe("ok");
    expect(bridge.handleRequest).toHaveBeenCalledWith("alpha/open", { id: 1 });
    await expect(bridges.handleRequest("beta/open", {})).rejects.toThrow(
      'Output session "beta" is unavailable for this output',
    );
    await expect(bridges.handleRequest("gamma/open", {})).rejects.toThrow(
      "No output session plugin serves gamma/open",
    );

    bridges.notifyCurrentState();
    expect(bridge.notifyCurrentState).toHaveBeenCalledOnce();
    bridges.dispose();
    expect(bridge.dispose).toHaveBeenCalledOnce();
  });
});
