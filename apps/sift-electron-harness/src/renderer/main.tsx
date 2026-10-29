/**
 * Harness renderer: one `SiftTable` over a ranged-IPC `byte-source`, wired
 * the way Kilo Desktop's Files table viewer wires it, plus a status strip the
 * e2e reads. Query parameters (set by the main process from launch args):
 *
 *   file       absolute path the main process allowed
 *   worker     1 (default) | 0
 *   autoLoad   scroll (default) | manual | off
 *   cap        worker allocationCap in bytes (default: Sift's, 2.5 × maxDecodedBytes)
 *   maxDecoded limits.maxDecodedBytes (default 512 MiB)
 *   spawn      module (default) | blob: how the factory creates the worker
 *   origin     informational; the origin itself decides the CSP
 */

import {
  setWasmUrl,
  setWorkerFactory,
  SiftTable,
  type SiftLoadMilestone,
  type SiftSource,
  type TableEngineState,
} from "@nteract/sift";
// KD's form: the binary goes through Vite's asset pipeline and is served from
// the app origin. The worker receives this URL in its `open` message.
import siftWasmUrl from "@nteract/sift/sift.wasm?url";
// The same worker bundle as a plain URL, for the blob shim below.
import siftWorkerUrl from "@nteract/sift/worker?worker&url";
import "@nteract/sift/style.css";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type { OpenedFile } from "../shared/bridge";
import { createRangeByteSource } from "./range-byte-source";
import "./harness.css";

const MiB = 1024 * 1024;
const params = new URLSearchParams(location.search);
const filePath = params.get("file");
const useWorker = params.get("worker") !== "0";
const autoLoadMode = (params.get("autoLoad") ?? "scroll") as "scroll" | "manual" | "off";
const maxDecodedBytes = Number(params.get("maxDecoded")) || 512 * MiB;
const cap = params.get("cap") ? Number(params.get("cap")) : undefined;
const spawnMode = params.get("spawn") === "blob" ? "blob" : "module";

type WorkerState = "none" | "spawned" | "terminated";

/** Everything the status strip shows, mirrored on `window.__harness` for e2e. */
type HarnessState = {
  origin: string;
  worker: WorkerState;
  spawns: number;
  workerErrors: string[];
  /** Largest `memoryBytes` the worker reported after a row group. */
  peakWorkerMemory: number;
  milestones: SiftLoadMilestone[];
  lastMilestone: string | null;
  state: TableEngineState | null;
  errors: string[];
  stale: boolean;
  chunks: number;
  file: OpenedFile | null;
  /** `securitypolicyviolation` events on this document: `directive blockedURI`. */
  cspViolations: string[];
  /** The `.wasm` URL handed to `setWasmUrl` (and forwarded to the worker). */
  wasmUrl: string;
};

const harness: HarnessState = {
  origin: location.origin,
  worker: "none",
  spawns: 0,
  workerErrors: [],
  peakWorkerMemory: 0,
  milestones: [],
  lastMilestone: null,
  state: null,
  errors: [],
  stale: false,
  chunks: 0,
  file: null,
  cspViolations: [],
  wasmUrl: siftWasmUrl,
};
(window as unknown as { __harness: HarnessState }).__harness = harness;

const listeners = new Set<() => void>();
function update(patch: Partial<HarnessState>) {
  Object.assign(harness, patch);
  for (const listener of listeners) listener();
}

function useHarness(): HarnessState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return harness;
}

document.addEventListener("securitypolicyviolation", (event) => {
  update({
    cspViolations: [...harness.cspViolations, `${event.effectiveDirective} ${event.blockedURI}`],
  });
});

setWasmUrl(siftWasmUrl);

/**
 * `module`: the documented same-origin module worker. Vite resolves the
 * package export and emits the worker bundle as an app-origin asset.
 *
 * `blob`: a one-line module shim at a `blob:` URL that imports that same
 * bundle. The app-origin CSP refuses it (no `worker-src`, so `script-src
 * 'self'` applies); the embedded policy (`worker-src 'self' blob:`) allows it.
 */
function spawnWorker(): Worker {
  if (spawnMode === "blob") {
    const shim = new Blob([`import ${JSON.stringify(siftWorkerUrl)};`], {
      type: "text/javascript",
    });
    return new Worker(URL.createObjectURL(shim), { type: "module" });
  }
  return new Worker(new URL("@nteract/sift/worker", import.meta.url), { type: "module" });
}

// The wrapper only observes: spawn and terminate for the status strip, and
// the worker's own `progress` replies for peak heap.
setWorkerFactory(() => {
  const worker = spawnWorker();
  update({ worker: "spawned", spawns: harness.spawns + 1 });
  worker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { t?: string; memoryBytes?: number } | null;
    if (data?.t === "progress" && typeof data.memoryBytes === "number") {
      if (data.memoryBytes > harness.peakWorkerMemory) {
        update({ peakWorkerMemory: data.memoryBytes });
      }
    }
  });
  worker.addEventListener("error", (event: ErrorEvent) => {
    update({ workerErrors: [...harness.workerErrors, event.message || "worker error event"] });
  });
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    terminate();
    update({ worker: "terminated" });
  };
  return worker;
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StatusStrip() {
  const h = useHarness();
  return (
    <div className="harness-status" role="status">
      <span>
        origin <b data-testid="origin">{h.origin}</b>
      </span>
      <span>
        worker <b data-testid="worker-state">{h.worker}</b>
      </span>
      <span>
        milestone <b data-testid="milestone">{h.lastMilestone ?? "—"}</b>
      </span>
      <span>
        rows <b data-testid="loaded-count">{h.state?.loadedCount ?? h.state?.totalCount ?? "—"}</b>
        {" / "}
        <b data-testid="total-count">{h.state?.totalCount ?? "—"}</b>
      </span>
      <span>
        failed <b data-testid="data-failed">{String(h.state?.dataFailed ?? false)}</b>
      </span>
      <span>
        peak heap <b data-testid="peak-memory">{h.peakWorkerMemory}</b>
      </span>
      <span className="harness-error">
        error <b data-testid="error">{h.errors.at(-1) ?? ""}</b>
      </span>
    </div>
  );
}

function Table({ file }: { file: OpenedFile }) {
  const source = useMemo<SiftSource>(() => {
    const byteSource = createRangeByteSource({
      readRange: window.harness.readRange,
      path: file.path,
      byteLength: file.byteLength,
      revision: file.revision,
      onStale: () => update({ stale: true }),
      onChunk: () => {
        harness.chunks++;
      },
    });
    return {
      kind: "byte-source",
      source: byteSource,
      limits: { maxRows: 1_000_000, maxDecodedBytes },
      overflow: "truncate",
      autoLoad:
        autoLoadMode === "off"
          ? undefined
          : { rows: 100_000, decodedBytes: 64 * MiB, trigger: autoLoadMode },
      worker: useWorker,
      // Leave Sift's default (2.5 × maxDecodedBytes) in force unless ?cap= overrides it,
      // so the harness exercises the shipped default rather than its own.
      allocationCap: cap,
    };
  }, [file]);

  return (
    <SiftTable
      className="harness-table"
      source={source}
      onLoadMilestone={(milestone) => {
        console.info("[harness] milestone", JSON.stringify(milestone));
        update({
          milestones: [...harness.milestones, milestone],
          lastMilestone: milestone.phase,
        });
      }}
      onLoadError={(error) => {
        console.info("[harness] load error", error.message);
        update({ errors: [...harness.errors, error.message] });
      }}
      onChange={(state) => update({ state })}
    />
  );
}

function App() {
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) return;
    window.harness.openFile(filePath).then(
      (opened) => {
        update({ file: opened });
        setFile(opened);
      },
      (error: unknown) => setOpenError(errorText(error)),
    );
  }, []);

  const pick = () => {
    window.harness.openFile().then(
      (opened) => {
        if (!opened) return;
        update({ file: opened });
        setFile(opened);
      },
      (error: unknown) => setOpenError(errorText(error)),
    );
  };

  return (
    <div className="harness">
      <StatusStrip />
      {openError && <div className="harness-error">{openError}</div>}
      {file ? (
        <Table key={`${file.path}:${file.revision}`} file={file} />
      ) : (
        <div className="harness-empty">
          <button type="button" onClick={pick}>
            Open a Parquet file…
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
