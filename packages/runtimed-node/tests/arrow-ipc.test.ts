import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const runNativeIntegration = process.env.RUNTIMED_NODE_NATIVE_INTEGRATION === "1";
const describeNative = runNativeIntegration ? describe : describe.skip;

type NativeBinding = {
  readArrowFile: (
    filePath: string,
    offset: number,
    limit: number,
  ) => {
    columns: string[];
    rows: string[][];
    totalRows: number;
    offset: number;
  };
  readArrowChunks: (
    filePaths: string[],
    offset: number,
    limit: number,
  ) => {
    columns: string[];
    rows: string[][];
    totalRows: number;
    offset: number;
  };
  summarizeArrowFile: (filePath: string) => {
    numRows: number;
    columns: Array<{ name: string; dataType: string }>;
  };
  summarizeArrowChunks: (filePaths: string[]) => { numRows: number };
  resolveBlobPath: (hash: string, socketPath?: string | null) => string | null;
};

function loadNativeBinding(): NativeBinding {
  try {
    const loaded = require("../src/index.cjs") as Partial<NativeBinding>;
    if (
      typeof loaded.readArrowFile !== "function" ||
      typeof loaded.readArrowChunks !== "function" ||
      typeof loaded.summarizeArrowFile !== "function" ||
      typeof loaded.summarizeArrowChunks !== "function" ||
      typeof loaded.resolveBlobPath !== "function"
    ) {
      throw new Error("rebuilt @runtimed/node binding is missing Arrow IPC exports");
    }
    return loaded as NativeBinding;
  } catch (error) {
    throw new Error(
      "Failed to load @runtimed/node native binding. Run `pnpm --dir packages/runtimed-node build:debug` before this integration test.",
      { cause: error },
    );
  }
}

const binding = runNativeIntegration ? loadNativeBinding() : null;
const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../sift/public/polars-utf8view.arrow",
);

function nativeBinding(): NativeBinding {
  if (!binding) {
    throw new Error("Set RUNTIMED_NODE_NATIVE_INTEGRATION=1 to run this native integration test.");
  }
  return binding;
}

describeNative("@runtimed/node Arrow IPC native integration", () => {
  it("reads and summarizes a real Utf8View Arrow stream fixture", () => {
    const native = nativeBinding();
    const page = native.readArrowFile(fixture, 0, 3);
    const summary = native.summarizeArrowFile(fixture);

    expect(page.columns).toEqual(["id", "name", "note", "score", "event_ts"]);
    expect(page.rows).toHaveLength(3);
    expect(page.totalRows).toBe(100);
    expect(summary.numRows).toBe(100);
    expect(summary.columns.map((column) => column.dataType)).toEqual([
      "int64",
      "string",
      "string",
      "float64",
      "timestamp[microsecond]",
    ]);
  });

  it("paginates across multiple Arrow stream chunks", () => {
    const native = nativeBinding();
    const page = native.readArrowChunks([fixture, fixture], 98, 5);
    const summary = native.summarizeArrowChunks([fixture, fixture]);

    expect(page.totalRows).toBe(200);
    expect(page.offset).toBe(98);
    expect(page.rows.map((row) => row[0])).toEqual(["98", "99", "0", "1", "2"]);
    expect(summary.numRows).toBe(200);
  });

  it("resolves blob hashes through the daemon blob-store sharding layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtimed-node-arrow-"));
    const socketPath = path.join(root, "daemon.sock");
    const hash = "abcdef0123456789";
    const blobPath = path.join(root, "blobs", "ab", "cdef0123456789");
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(blobPath, "arrow");

    try {
      const native = nativeBinding();
      expect(native.resolveBlobPath(hash, socketPath)).toBe(blobPath);
      expect(native.resolveBlobPath("not-a-hash", socketPath)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
