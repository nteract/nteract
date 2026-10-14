/**
 * @nteract/sift-csv — CSV and TSV to Arrow IPC, in WebAssembly.
 *
 *   import { csvToArrowIpc } from '@nteract/sift-csv'
 *   import { loadTableFile } from '@nteract/sift'
 *
 *   const ipc = await csvToArrowIpc(text, { delimiter: '\t' })
 *   const data = await loadTableFile(ipc, { format: 'arrow-ipc' })
 *
 * The output is an uncompressed Arrow IPC stream, so any Arrow reader can use
 * it, not only Sift. Type inference reads the whole file: booleans, Int64,
 * Float64 (including exponents), Date32, and Timestamp columns are detected;
 * a column with mixed shapes stays text. Empty fields are null in every type.
 */

export type CsvToArrowOptions = {
  /** Single ASCII field delimiter. Default `,`. */
  delimiter?: string;
  /** Whether the first record names the columns. Default true. */
  hasHeader?: boolean;
  /** Maximum input bytes. Default 16 MiB. */
  maxBytes?: number;
  /** Maximum data rows. Default 100,000. */
  maxRows?: number;
  /** Maximum columns. Default 256. */
  maxColumns?: number;
  /**
   * Maximum bytes in the Arrow IPC output, which is close to the memory a
   * consumer retains for the table. Default 128 MiB.
   */
  maxOutputBytes?: number;
};

type WasmModule = {
  default: (options?: {
    module_or_path?: string | URL | ArrayBuffer | Uint8Array;
  }) => Promise<unknown>;
  csvToArrowIpc: (bytes: Uint8Array, options: Record<string, unknown> | undefined) => Uint8Array;
};

type WasmModuleLoader = () => Promise<WasmModule>;

const defaultLoader: WasmModuleLoader = () =>
  import("sift-csv-wasm/sift_csv_wasm.js") as unknown as Promise<WasmModule>;

let loader: WasmModuleLoader = defaultLoader;
let wasmUrl: string | URL | undefined;
let module: WasmModule | null = null;
let initializing: Promise<WasmModule> | null = null;

/**
 * Where to fetch `sift_csv_wasm_bg.wasm`. Call before the first conversion when
 * the default (next to this package's `lib/wasm/` glue, via `import.meta.url`)
 * does not resolve in your host, such as an iframe or a bundler that moves
 * assets. Bundlers can supply it with `new URL('@nteract/sift-csv/wasm',
 * import.meta.url)`.
 */
export function setWasmUrl(url: string | URL): void {
  wasmUrl = url;
}

/**
 * wasm-bindgen's glue fetches the binary from a URL. Node's `fetch` rejects
 * `file:` URLs, which is what `import.meta.url` resolves to there, so read
 * those with the filesystem instead. Browsers never see a `file:` URL here
 * unless the page itself is one, and then `fetch` handles it.
 */
async function wasmInput(url: string | URL): Promise<string | URL | Uint8Array> {
  const resolved = url instanceof URL ? url : new URL(url, import.meta.url);
  if (resolved.protocol !== "file:" || typeof process === "undefined" || !process.versions?.node) {
    return resolved;
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(resolved));
}

async function ensureModule(): Promise<WasmModule> {
  if (module) return module;
  initializing ??= (async () => {
    const wasm = await loader();
    const url = wasmUrl ?? new URL("./wasm/sift_csv_wasm_bg.wasm", import.meta.url);
    await wasm.default({ module_or_path: await wasmInput(url) });
    module = wasm;
    return wasm;
  })().catch((error: unknown) => {
    initializing = null;
    throw error;
  });
  return initializing;
}

/**
 * Convert CSV text or bytes to an Arrow IPC stream. Rejects with the reason
 * when the input is malformed (ragged rows, unbalanced quotes) or crosses a
 * limit; it never truncates or samples.
 */
export async function csvToArrowIpc(
  input: string | Uint8Array,
  options: CsvToArrowOptions = {},
): Promise<Uint8Array> {
  if (options.delimiter !== undefined) {
    const code = options.delimiter.codePointAt(0);
    if (options.delimiter.length !== 1 || code === undefined || code > 0x7f) {
      throw new Error("delimiter must be a single ASCII character");
    }
  }
  const wasm = await ensureModule();
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  // serde deserializes `undefined` as a unit, not as a missing field, so drop
  // undefined entries; the Rust side fills in the defaults.
  const { delimiter, ...rest } = options;
  const wasmOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) wasmOptions[key] = value;
  }
  if (delimiter !== undefined) wasmOptions.delimiter = delimiter.charCodeAt(0);
  return wasm.csvToArrowIpc(bytes, wasmOptions);
}

/** @internal Swap the WASM loader in tests; `null` restores the real one. */
export function _setWasmModuleLoaderForTests(next: WasmModuleLoader | null): void {
  loader = next ?? defaultLoader;
  module = null;
  initializing = null;
}
