// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeState, Session } from "../src/index";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const nativeEnabled = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";
const executionEnabled = process.env.RUNTIMED_NODE_EXECUTION_INTEGRATION === "1";

describe.skipIf(!nativeEnabled)("explicit environment.yml initialization", () => {
  let rt: typeof import("../src/index");
  let relayApi: typeof import("../src/relay");
  let directory: string;
  let socketPath: string;
  let daemon: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let logs = "";

  beforeAll(async () => {
    rt = require("../src/index.cjs");
    relayApi = require("../src/relay.cjs");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "runt-manifest-"));
    const condaEnvs = path.join(directory, "conda-envs");
    fs.mkdirSync(condaEnvs);
    socketPath = path.join(directory, "daemon.sock");
    const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
    const binary = path.join(
      target,
      "debug",
      process.platform === "win32" ? "runtimed.exe" : "runtimed",
    );
    if (!fs.existsSync(binary))
      throw new Error("Run cargo build -p runtimed before manifest tests.");
    daemon = spawn(
      binary,
      [
        "--dev",
        "run",
        "--socket",
        socketPath,
        "--cache-dir",
        path.join(directory, "envs"),
        "--blob-store-dir",
        path.join(directory, "blobs"),
        "--settings-json",
        path.join(directory, "settings.json"),
        "--uv-pool-size",
        "0",
        "--conda-pool-size",
        "0",
        "--pixi-pool-size",
        "0",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          RUNTIMED_DEV: "1",
          RUNTIMED_WORKSPACE_PATH: directory,
          CONDA_ENVS_DIRS: condaEnvs,
          RATTLER_CACHE_DIR: path.join(directory, "rattler-cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    exited = once(daemon, "exit");
    const record = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16000);
    };
    daemon.stdout?.on("data", record);
    daemon.stderr?.on("data", record);
    await vi.waitFor(
      async () => {
        if (daemon?.exitCode !== null) throw new Error(`Daemon exited before readiness: ${logs}`);
        expect(await relayApi.queryDaemonInfo({ socketPath })).toBeTruthy();
      },
      { timeout: 15000 },
    );
  }, 20000);

  afterAll(async () => {
    if (daemon && exited) {
      daemon.kill("SIGINT");
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGKILL");
        await exited;
      }
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("rejects invalid specs and existing manifests through the public binding", async () => {
    const project = fs.mkdtempSync(path.join(directory, "validation-"));
    const options = {
      directory: project,
      dependencies: ["six"],
      python: "3.12",
      channels: ["conda-forge"],
    };
    await expect(
      rt.initializeEnvironmentYml({ ...options, dependencies: ["bad!package"] }),
    ).rejects.toThrow();
    expect(fs.readdirSync(project)).toEqual([]);
    const manifest = await rt.initializeEnvironmentYml(options);
    expect(manifest).toBe(path.join(fs.realpathSync(project), "environment.yml"));
    const original = fs.readFileSync(manifest, "utf8");
    await expect(rt.initializeEnvironmentYml(options)).rejects.toThrow("already exists");
    expect(fs.readFileSync(manifest, "utf8")).toBe(original);
    expect(fs.readdirSync(project)).toEqual(["environment.yml"]);
  });

  async function createProject() {
    const project = fs.mkdtempSync(path.join(directory, "project-"));
    const notebookPath = path.join(project, "analysis.ipynb");
    // Opening an untrusted file must not install anything. createNotebook's
    // explicit dependencies argument is itself setup consent, so it is not a
    // suitable fixture for proving that initialization preserves trust.
    fs.writeFileSync(
      notebookPath,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        cells: [],
        metadata: {
          kernelspec: { name: "python3", language: "python", display_name: "Python 3" },
          runt: { schema_version: "1", uv: { dependencies: ["six"] } },
        },
      }),
    );
    const session: Session = await rt.openNotebookPath(notebookPath, { socketPath });
    let state: RuntimeState = {};
    const subscription = session.runtimeState$.subscribe((value) => {
      state = value;
    });
    try {
      expect(fs.existsSync(path.join(project, "environment.yml"))).toBe(false);
      await vi.waitFor(() => expect(state.project_context).toMatchObject({ state: "NotFound" }), {
        timeout: 10000,
      });
      expect(fs.existsSync(path.join(project, "environment.yml"))).toBe(false);
      const before = await session.getRuntimeStatus();
      const trust = (await session.getDependencyStatus()).trust;
      expect(trust).toMatchObject({ status: "untrusted", needsApproval: true });
      expect(before.runtimeAgentId).toBe("");
      const manifest = await rt.initializeEnvironmentYml({
        directory: project,
        name: `runt-manifest-${path.basename(project)}`,
        dependencies: ["six"],
        python: "3.12",
        channels: ["conda-forge"],
      });
      expect(await session.getRuntimeStatus()).toEqual(before);
      expect((await session.getDependencyStatus()).trust).toEqual(trust);
      expect(fs.readdirSync(project).sort()).toEqual(["analysis.ipynb", "environment.yml"]);
      return { project, notebookPath, manifest };
    } finally {
      subscription.unsubscribe();
      await session.shutdownNotebook();
      await session.close();
    }
  }

  it("creates only on request and is found by ordinary notebook project discovery", async () => {
    const { notebookPath, manifest } = await createProject();
    const session = await rt.openNotebookPath(notebookPath, { socketPath });
    let state: RuntimeState = {};
    const subscription = session.runtimeState$.subscribe((value) => {
      state = value;
    });
    try {
      await vi.waitFor(() =>
        expect(state.project_context).toMatchObject({
          state: "Detected",
          project_file: { absolute_path: manifest, kind: "EnvironmentYml" },
          parsed: {
            dependencies: ["six"],
            requires_python: "3.12.*",
            extras: { channels: ["conda-forge"] },
          },
        }),
      );
      expect((await session.getRuntimeStatus()).runtimeAgentId).toBe("");
    } finally {
      subscription.unsubscribe();
      await session.shutdownNotebook();
      await session.close();
    }
  }, 30000);

  it.skipIf(!executionEnabled)(
    "uses the created project environment for the first explicit execution",
    async () => {
      const { notebookPath, manifest } = await createProject();
      const session = await rt.openNotebookPath(notebookPath, { socketPath });
      const relay = await rt.connectRelay(session.notebookId, { socketPath });
      try {
        // Separate explicit setup consent, using the existing notebook request.
        // Manifest creation itself must never issue either approval.
        const id = "manifest-project-approval";
        let response: { id?: string; result?: string } | undefined;
        const unlisten = relay.onFrame((frame) => {
          if (frame[0] !== 0x02) return;
          const candidate = JSON.parse(frame.subarray(1).toString());
          if (candidate.id === id) response = candidate;
        });
        try {
          await relay.send(
            Buffer.concat([
              Buffer.from([0x01]),
              Buffer.from(
                JSON.stringify({
                  id,
                  action: "approve_project_environment",
                  project_file_path: manifest,
                }),
              ),
            ]),
          );
          await vi.waitFor(() => expect(response).toMatchObject({ id, result: "ok" }));
        } finally {
          unlisten();
        }
        await session.approveTrust();
        const result = await session.runCell("import six\nprint(1 + 1)", { timeoutMs: 240000 });
        expect(result.success).toBe(true);
        expect(
          result.outputs
            .filter((output) => output.outputType === "stream" && output.name === "stdout")
            .map((output) => output.text ?? "")
            .join("")
            .trim(),
        ).toBe("2");
        expect((await session.getRuntimeStatus()).envSource).toBe("conda:env_yml");
      } catch (error) {
        throw new Error(
          `${error}\nRuntime: ${JSON.stringify(await session.getRuntimeStatus())}\nDaemon logs:\n${logs}`,
          { cause: error },
        );
      } finally {
        await relay.close();
        await session.shutdownNotebook();
        await session.close();
      }
    },
    300000,
  );
});
