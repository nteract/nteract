import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.scratch/", import.meta.url));

// Small real-server harness for runtime probes. Files and storage belong only
// to this invocation; cleanup never targets another celld process.
export async function startCelld(files, config = {}, environment = {}, { watch = false } = {}) {
  await mkdir(resolve(root, ".celld"), { recursive: true });
  const project = await mkdtemp(resolve(root, ".celld/probe-"));
  let child,
    stopped,
    logs = "",
    closing;
  const signal = (name) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = async (crash = false) => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // celld dev puts its node in a separate process group. Capture only
      // descendants of our live supervisor before any signal or reparenting.
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const owned = new Set([child.pid]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const [pid, parent] of rows) {
          if (owned.has(parent) && !owned.has(pid)) {
            owned.add(pid);
            changed = true;
          }
        }
      }
      const killDescendants = () => {
        for (const pid of owned) {
          if (pid === child.pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      };
      signal(crash ? "SIGKILL" : "SIGTERM");
      if (crash) killDescendants();
      let timer;
      await Promise.race([
        stopped,
        new Promise((done) => {
          timer = setTimeout(done, 5000);
        }),
      ]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        signal("SIGKILL");
        killDescendants();
      }
      await stopped;
      // Wait for killed descendants to exit before reusing the listener and
      // storage. A zombie has closed its descriptors and awaits its reaper.
      const deadline = Date.now() + 5000;
      while (true) {
        const live = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter(([pid, state]) => owned.has(Number(pid)) && !state.startsWith("Z"));
        if (live.length === 0) break;
        if (Date.now() > deadline)
          throw new Error(`Test-owned processes did not stop: ${JSON.stringify(live)}`);
        await new Promise((done) => setTimeout(done, 25));
      }
      return [...owned];
    }
  };
  const close = () =>
    (closing ??= (async () => {
      await stop();
      await rm(project, { recursive: true, force: true });
    })());
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(resolve(project, name)), { recursive: true });
      await writeFile(resolve(project, name), contents);
    }
    await writeFile(
      resolve(project, "wrangler.json"),
      JSON.stringify({
        name: "python-runtime-probe",
        main: "index.js",
        no_bundle: true,
        compatibility_date: "2026-09-21",
        ...config,
      }),
    );
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const bin = process.env.CELLD_BIN;
    if (!bin) throw new Error("Set CELLD_BIN to a qualified celld Python Workers build");
    const launch = async () => {
      let runLogs = "";
      child = spawn(
        bin,
        ["dev", project, "--port", String(port), ...(watch ? [] : ["--no-watch"]), "--logs"],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...environment },
        },
      );
      stopped = new Promise((done) => {
        child.once("exit", done);
        child.once("error", done);
      });
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`startup timeout\n${runLogs}`)), 60000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`celld exited ${code}\n${runLogs}`));
        });
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (data) => {
            logs += data;
            runLogs += data;
            if (runLogs.includes("ready  http://")) {
              clearTimeout(timer);
              done();
            }
          });
      });
    };
    await launch();
    return {
      async write(name, contents) {
        if (
          !/^[a-zA-Z_][a-zA-Z_0-9]*\.py$/.test(name) &&
          !["requirements.txt", "pyproject.toml", "celld-python.lock.json"].includes(name)
        )
          throw new Error("Test source must be a flat Python module or package manifest/lock");
        await writeFile(resolve(project, name), contents);
      },
      url: `http://127.0.0.1:${port}`,
      get pid() {
        return child.pid;
      },
      close,
      logs: () => logs,
      async restart({ crash = false } = {}) {
        if (closing) throw new Error("Cannot restart a closed test server");
        const stoppedPids = await stop(crash);
        await launch();
        return { stoppedPids, pid: child.pid, crash };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
