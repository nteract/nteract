import type { SchedulerLike } from "rxjs";

export type OutputState =
  | "connecting"
  | "booting"
  | "loading"
  | "importing"
  | "initializing"
  | "rendering"
  | "ready"
  | "failed"
  | "disposed";
export interface OutputAsset {
  bytes: Uint8Array;
  mediaType: string;
  assetId?: string;
}
export interface WidgetDefinition {
  /** Named text/javascript asset containing a standard AFM. */
  _esm: string;
  /** Optional named text/css asset. */
  _css?: string;
  state?: Record<string, unknown>;
  buffers?: string[];
  buffer_paths?: (string | number)[][];
}
export interface AnywidgetSpec extends WidgetDefinition {
  /** Additional models referenced as anywidget:<id>. The root ID is root. */
  models?: Record<string, WidgetDefinition>;
}
export interface AnywidgetOutput {
  title?: string;
  spec: AnywidgetSpec;
  assets: Record<string, OutputAsset>;
  imports?: Record<string, OutputAsset>;
  /**
   * Bare name → URL of a library module the embedder serves on its own
   * origin: `<origin>/catalog/<revision>/<file>.js`, one revision per map,
   * over https (http only on a loopback host). At most 64.
   */
  libraries?: Record<string, string>;
  /**
   * Library module URL (a library or a chunk it imports, in the same catalog
   * revision) → `sha256-<base64>` of its bytes. The frame's import map
   * carries it, so the browser refuses a module whose bytes differ.
   */
  libraryIntegrity?: Record<string, string>;
}
export interface ByteSource {
  readonly byteLength: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface ModuleOutput {
  kind: "module";
  title?: string;
  assets: { entry: OutputAsset };
  imports?: Record<string, OutputAsset>;
  /**
   * Bare name → URL of a library module the embedder serves on its own
   * origin: `<origin>/catalog/<revision>/<file>.js`, one revision per map,
   * over https (http only on a loopback host). At most 64.
   */
  libraries?: Record<string, string>;
  /**
   * Library module URL (a library or a chunk it imports, in the same catalog
   * revision) → `sha256-<base64>` of its bytes. The frame's import map
   * carries it, so the browser refuses a module whose bytes differ.
   */
  libraryIntegrity?: Record<string, string>;
}
export type ColumnType = "number" | "bigint" | "date" | "string" | "boolean" | "other";
/** One column of a ColumnSet (src/column-set.mjs). `nulls` is a validity mask, 1 = present. */
export interface ColumnSetColumn {
  name: string;
  type: ColumnType;
  values: Float64Array | BigInt64Array | BigUint64Array | unknown[];
  nulls?: Uint8Array;
}
/** A table as it crosses the frame boundary: structured-cloneable, no class instances. */
export interface ColumnSet {
  numRows: number;
  columns: ColumnSetColumn[];
}
/** The formats a file can be read as a table in: `parquet()` and `csv()`. */
export type TableFormat = "parquet" | "csv";
/**
 * A module view's data input: one file the embedder serves when the view
 * asks (src/byte-source.mjs). Nothing is read at mount.
 */
export interface FileInput extends ByteSource {
  readonly mimeType: string;
  /**
   * The whole file, for a file of at most 5 MiB. Called for one request at a
   * time and delivered at most once per exposed file; the view's live files
   * read whole stay within 32 MiB.
   */
  bytes(signal: AbortSignal): Promise<Uint8Array>;
  /**
   * The file read as a table in `format`, as a ColumnSet the embedder checks
   * when it decodes it; it rejects for a format the file cannot be read in.
   * Called for one request at a time per format and delivered at most once
   * per format per exposed file. Absent when the file is no table in any
   * format: `parquet()` and `csv()` then reject.
   */
  columns?(format: TableFormat, signal: AbortSignal): Promise<ColumnSet>;
}
/** A span of a file, from `file.slice(start, end)`. */
export interface FileRange {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
/**
 * What a module view gets for each bound file, from `model.get(alias)` and
 * from `import f from "data/<alias>"` (src/file-object.mjs). `byteLength`
 * and `read` make it a Sift byte source.
 */
export interface FileObject extends ByteSource {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  parquet(): Promise<ColumnTable>;
  /**
   * The file parsed as CSV: one plain object per data row, with typed values
   * as `parquet()` gives them, and `columns` naming the columns in file
   * order. Values are always typed, so the options object may be empty or
   * `{ typed: true }`.
   */
  csv(options?: { typed?: true }): Promise<CsvRows>;
  slice(start?: number, end?: number): FileRange;
}
/** What `csv()` resolves to: Observable FileAttachment.csv's shape. */
export type CsvRows = Row[] & { columns: string[] };
/** A column type as an Arrow DataType reads (typeId from apache-arrow's Type enum). */
export interface ColumnDataType {
  readonly typeId: number;
  readonly unit?: number;
  readonly bitWidth?: number;
  readonly kind: ColumnType;
}
/** One row as a plain object; the view may change it. */
type Row = Record<string, unknown>;
/** One column of a ColumnTable, spelled as an Arrow JS vector. */
export interface TableColumn extends Iterable<unknown> {
  readonly length: number;
  readonly nullCount: number;
  readonly type: ColumnDataType;
  get(index: number): unknown;
  toArray(): Float64Array | BigInt64Array | BigUint64Array | readonly unknown[];
  toJSON(): Float64Array | BigInt64Array | BigUint64Array | readonly unknown[];
}
/** What a module view's model holds for a Parquet file (src/table.mjs): an Arrow-style table. */
export interface ColumnTable extends Iterable<Row> {
  readonly numRows: number;
  readonly numCols: number;
  readonly schema: {
    readonly fields: readonly { name: string; type: ColumnDataType; nullable: boolean }[];
  };
  getChild(name: string): TableColumn | null;
  getChildAt(index: number): TableColumn | null;
  get(index: number): Row | null;
  toArray(): readonly Row[];
  select(names: readonly string[]): ColumnTable;
}
/** A module view's file (the model holds a FileObject) or an anywidget buffer. */
export type DataInput = FileInput | Uint8Array;
export interface OutputOptions {
  /** A module view's `data/<alias>` files. Each alias is also a key on its model. */
  files?: Record<string, FileInput>;
  /** The output host's frame path, which serves the bootstrap document. */
  frameUrl: string;
  /**
   * The frame runtime's text, from the embedder's own build, or a function
   * that resolves to it. The host sends it to the bootstrap at boot.
   */
  runtime: string | (() => string | Promise<string>);
  hostContext: OutputHostContext;
  /** The startup limit, from mount to "ready". Default 20 000 ms. */
  timeoutMs?: number;
  /** How long "booting" waits for the runtime to answer. Default 10 000 ms. */
  bootTimeoutMs?: number;
  scheduler?: SchedulerLike;
  onState?: (state: OutputState, error?: string) => void;
  /**
   * A data change reached a rendered view with no `change:<key>` listener on
   * any key it affects, so the frame did not apply it. Called only in "ready"
   * and only for a declared data name. Mount the view again to show it.
   */
  onUnhandledData?: (name: string) => void;
}
export interface OutputHandle {
  readonly frame: HTMLIFrameElement;
  readonly state: OutputState;
  setHostContext(context: OutputHostContext): void;
  /**
   * Offer a mounted view a new value for one declared data input: a
   * `data/<alias>` of a module view (a FileInput), or a buffer name of an
   * anywidget view (Uint8Array only). Sent once the view has rendered; throws for an
   * undeclared name. A view with no listener for it answers through
   * `onUnhandledData`.
   */
  setData(name: string, value: DataInput): void;
  destroy(): void;
}
/** Structurally compatible with the theme/styles subset of notebook HostContext. */
export interface OutputHostContext {
  theme: "light" | "dark";
  styles?: { variables?: Readonly<Record<string, string>> };
}
export const OUTPUT_STYLE_VARIABLES: readonly string[];
export function readHostContext(element: HTMLElement, theme: "light" | "dark"): OutputHostContext;
/** Immutable mount. Bytes are copied before transfer; caller buffers remain usable. */
export function mountAnywidgetOutput(
  container: HTMLElement,
  payload: AnywidgetOutput,
  options: OutputOptions,
): OutputHandle;

export function mountModuleOutput(
  container: HTMLElement,
  payload: AnywidgetOutput | ModuleOutput,
  options: OutputOptions,
): OutputHandle;

/** The AFM model API, with local-only save_changes and unsupported backend send. */
export interface AnyModel<T extends Record<string, unknown> = Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  on(event: `change:${string}`, callback: () => void): void;
  on(event: "msg:custom", callback: (message: unknown, buffers: DataView[]) => void): void;
  off(event?: string | null, callback?: Function | null): void;
  save_changes(): void;
  send(content: unknown, callbacks?: unknown, buffers?: ArrayBuffer[] | ArrayBufferView[]): void;
}
export interface WidgetHandle<T = unknown> {
  exports: T;
  render(options: { el: HTMLElement; signal?: AbortSignal }): Promise<void>;
}
/** AFM composition plus optional Pages theme helpers. */
export interface OutputRuntimeHost {
  getContext(): Readonly<OutputHostContext>;
  onContextChange(listener: (context: Readonly<OutputHostContext>) => void): () => void;
  getWidget<T = unknown>(ref: string): Promise<WidgetHandle<T>>;
  getModel<T extends Record<string, unknown> = Record<string, unknown>>(
    ref: string,
  ): Promise<AnyModel<T>>;
}
type Awaitable<T> = T | PromiseLike<T>;
type Cleanup = () => Awaitable<void>;
export interface Anywidget {
  initialize?(props: { model: AnyModel; signal: AbortSignal }): Awaitable<void | Cleanup | object>;
  render?(props: {
    model: AnyModel;
    el: HTMLElement;
    signal: AbortSignal;
    host: OutputRuntimeHost;
  }): Awaitable<void | Cleanup>;
}
export type AnywidgetModule = { default: Anywidget | (() => Awaitable<Anywidget>) };
