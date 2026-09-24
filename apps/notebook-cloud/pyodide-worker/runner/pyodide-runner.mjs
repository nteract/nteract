// Pyodide runner — local/dev harness for the pyodide.wasm adapter.
//
// Spawned by the Rust `PyodideKernel` (`crates/runtimed/src/pyodide_kernel.rs`)
// as a JSON-line subprocess. Protocol (one JSON object per line):
//
//   runner -> Rust:  {"type":"ready"}                        once Pyodide is loaded
//                    {"type":"stdout","text":"..."}          captured python stdout (batched)
//                    {"type":"stderr","text":"..."}          captured python stderr (batched)
//                    {"type":"install_progress","phase":"installing_packages"|"install_complete"|"error",
//                     "packages":[...],"message":"...","elapsed_ms":N}  startup declared-deps installs
//                    {"type":"installed","id":ID,"ok":true}
//                    {"type":"installed","id":ID,"ok":false,"error":"...","packages":[...]}
//                    {"type":"packages_installed","id":ID,"packages":[...]}  successful cell/request installs
//                    {"type":"result","id":ID,"ok":true,"repr":"..."}
//                    {"type":"result","id":ID,"ok":false,"ename":...,"evalue":...,"traceback":[...]}
//                    {"type":"fatal","error":"..."}          interpreter failed to start
//   Rust -> runner:  {"type":"execute","id":ID,"source":"..."}
//
// Security posture: the interpreter is assumed compromiseable. This process
// deliberately receives no host credentials — it only reads stdin and writes
// stdout.
//
// Pyodide resolution: `import("pyodide")` from the ambient node_modules, or
// PYODIDE_HOME pointing at a Pyodide distribution directory (index.js + wasm).

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// The raw Pyodide distribution's pyodide.mjs probes for Node built-ins via a
// bare `require()` call and reads `__dirname` to locate its index; provide
// both before importing it under ESM. (The `pyodide` npm package does this
// internally; these shims make the raw PYODIDE_HOME distribution work too.)
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}
if (typeof globalThis.__dirname === "undefined") {
  globalThis.__dirname = path.dirname(fileURLToPath(import.meta.url));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function loadPyodideRuntime() {
  const home = process.env.PYODIDE_HOME;
  if (home) {
    const mod = await import(
      new URL(`file://${home.replace(/\/$/, "")}/pyodide.mjs`, import.meta.url)
    );
    const loadPyodide = mod.loadPyodide ?? mod.default?.loadPyodide;
    if (!loadPyodide) throw new Error(`PYODIDE_HOME (${home}) has no pyodide.mjs entry`);
    return loadPyodide({ indexURL: `${home.replace(/\/$/, "")}/` });
  }
  const mod = await import("pyodide");
  const loadPyodide = mod.loadPyodide ?? mod.default?.loadPyodide;
  if (!loadPyodide) throw new Error("the `pyodide` package does not export loadPyodide");
  return loadPyodide();
}

let pyodide;

try {
  pyodide = await loadPyodideRuntime();
} catch (error) {
  emit({
    type: "fatal",
    error: `Failed to load Pyodide: ${error?.message ?? error}. Fetch the distribution \
with \`node apps/notebook-cloud/scripts/fetch-pyodide-assets.mjs\` (or install the \
\`pyodide\` npm package), or set RUNT_PYODIDE_HOME / PYODIDE_HOME to a Pyodide \
distribution directory.`,
  });
  process.exit(1);
}

// Capture python stdout/stderr into protocol lines (batched per write).
pyodide.setStdout({ batched: (text) => emit({ type: "stdout", text }) });
pyodide.setStderr({ batched: (text) => emit({ type: "stderr", text }) });

// micropip ships in the distribution but is not auto-installed; load it so
// cells can `import micropip` and install from PyPI at runtime.
await pyodide.loadPackage("micropip");

// Record successful micropip installs so packages installed by cell code
// become notebook dependencies and survive a restart. The
// Python shim wraps `micropip.install`, appending the requested requirement
// strings only after an install resolves — a raising install records nothing.
// The runner drains this list around each request and emits
// `{"type":"packages_installed","packages":[...]}`.
let recordedInstalls = [];
pyodide.globals.set("_runt_record_install", (requirementsJson) => {
  try {
    for (const req of JSON.parse(requirementsJson)) {
      if (typeof req === "string" && req.length > 0 && !recordedInstalls.includes(req)) {
        recordedInstalls.push(req);
      }
    }
  } catch {
    // A malformed record must never break execution.
  }
});
await pyodide.runPythonAsync(`
import json
import micropip

_micropip_install_original = micropip.install

async def _runt_recording_install(requirements, *args, **kwargs):
    result = await _micropip_install_original(requirements, *args, **kwargs)
    reqs = [requirements] if isinstance(requirements, str) else list(requirements)
    _runt_record_install(json.dumps([str(r) for r in reqs]))
    return result

micropip.install = _runt_recording_install
`);

function drainRecordedInstalls() {
  if (recordedInstalls.length === 0) return null;
  const packages = recordedInstalls;
  recordedInstalls = [];
  return packages;
}

// Declared dependencies (`runt.execution.dependencies`, passed as
// RUNT_PYODIDE_DEPS) install via micropip — the same resolver cells can use at
// runtime. They install *in the background* so readiness is not
// blocked on network I/O; each `execute` awaits this promise so a cell never
// runs before its declared packages are ready.
const INSTALL_TIMEOUT_MS = 180_000;
const declaredDeps = (process.env.RUNT_PYODIDE_DEPS ?? "")
  .split(",")
  .map((dep) => dep.trim())
  .filter((dep) => dep.length > 0);

const declaredDepsInstalled = (async () => {
  if (declaredDeps.length === 0) return;
  // Startup install progress rides the env.progress channel in the kernel so
  // the banner shows the same phases as a hot install.
  const startedAt = Date.now();
  emit({ type: "install_progress", phase: "installing_packages", packages: declaredDeps });
  emit({ type: "stdout", text: `Installing packages via micropip: ${declaredDeps.join(", ")}\n` });
  try {
    const installed = await Promise.race([
      (async () => {
        const micropip = pyodide.pyimport("micropip");
        await micropip.install(declaredDeps);
        return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), INSTALL_TIMEOUT_MS)),
    ]);
    if (installed) {
      emit({
        type: "install_progress",
        phase: "install_complete",
        packages: declaredDeps,
        elapsed_ms: Date.now() - startedAt,
      });
      emit({ type: "stdout", text: `Declared packages installed: ${declaredDeps.join(", ")}\n` });
    } else {
      emit({
        type: "install_progress",
        phase: "error",
        packages: declaredDeps,
        message: `Declared packages did not install within ${INSTALL_TIMEOUT_MS / 1000}s (network stalled?)`,
      });
      emit({
        type: "stderr",
        text: `Declared packages did not install within ${INSTALL_TIMEOUT_MS / 1000}s (network stalled?): ${declaredDeps.join(", ")}\n`,
      });
    }
  } catch (error) {
    emit({
      type: "install_progress",
      phase: "error",
      packages: declaredDeps,
      message: error?.message ?? String(error),
    });
    emit({
      type: "stderr",
      text: `Failed to install declared packages (${declaredDeps.join(", ")}): ${error?.message ?? error}\n`,
    });
  }
})();

emit({ type: "ready" });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    emit({ type: "fatal", error: `Malformed request line: ${line.slice(0, 200)}` });
    process.exit(1);
  }
  if (request.type === "install") {
    const { id, packages } = request;
    try {
      await declaredDepsInstalled;
      // Declared deps are already notebook metadata; drop any residue before
      // recording this request's own installs.
      drainRecordedInstalls();
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(packages);
      const captured = drainRecordedInstalls();
      emit({ type: "installed", id, ok: true });
      if (captured) emit({ type: "packages_installed", id, packages: captured });
    } catch (error) {
      drainRecordedInstalls();
      emit({
        type: "installed",
        id,
        ok: false,
        error: error?.message ?? String(error),
        // The failing requirements: lets the kernel name the offending package
        // without parsing the error prose.
        packages,
      });
    }
    continue;
  }
  if (request.type !== "execute") continue;

  const { id, source } = request;
  try {
    // Declared packages must be in place before user code runs; this resolves
    // immediately once the background install finishes.
    await declaredDepsInstalled;
    drainRecordedInstalls();
    const result = await pyodide.runPythonAsync(source);
    let repr = null;
    if (result !== undefined && result !== null) {
      try {
        repr = result.toString();
      } catch {
        repr = String(result);
      }
    }
    const captured = drainRecordedInstalls();
    if (captured) emit({ type: "packages_installed", id, packages: captured });
    emit({ type: "result", id, ok: true, repr });
  } catch (error) {
    const captured = drainRecordedInstalls();
    if (captured) emit({ type: "packages_installed", id, packages: captured });
    emit({
      type: "result",
      id,
      ok: false,
      ename: error?.constructor?.name ?? "Exception",
      evalue: error?.message ?? String(error),
      traceback:
        typeof error?.message === "string"
          ? error.message.split("\n").filter((l) => l.trim().length > 0)
          : [],
    });
  }
}
