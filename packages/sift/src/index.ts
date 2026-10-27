/**
 * @nteract/sift — public API
 *
 * React component:
 *   import { SiftTable } from '@nteract/sift'
 *   <SiftTable source={{ kind: 'loader', load }} onChange={handleState} />
 *
 * Imperative engine:
 *   import { createTable } from '@nteract/sift'
 *   const engine = createTable(container, tableData)
 *
 * State serialization:
 *   import { engineStateToExplorerState, predicateToSQL } from '@nteract/sift'
 *
 * Everything exported here is supported API. Internals such as the summary
 * accumulators stay private so they can change without a major version.
 */

// CSV/TSV input lives in @nteract/sift-csv, which produces Arrow IPC bytes
// for loadTableFile. Keeping the parser out of this package keeps its WASM
// to Parquet and Arrow.
export { loadTableFile } from "./file-data";
export type { TableFileLimits, TableFileOptions, TableLimitOverflow } from "./file-data";
// Byte-range Parquet: hosts implement ByteSource over a file, IPC call, or
// Range-capable URL and pass it to loadTableFile or a `byte-source` SiftSource.
export type { ByteSource } from "./parquet-file";
export type {
  BetweenPredicate,
  ColumnPredicate,
  CompoundPredicate,
  ContainsPredicate,
  EqPredicate,
  ExplorerState,
  FilterPredicate,
  InPredicate,
  IsNullPredicate,
  NotPredicate,
  SortEntry,
} from "./filter-schema";
// Filter schema & state serialization
export {
  columnFiltersToPredicates,
  engineStateToExplorerState,
  explorerStateToJSON,
  predicateToEnglish,
  predicateToPandas,
  predicateToSQL,
} from "./filter-schema";
export type { SiftFocusStatusProps, SiftScrollHandoffCueProps } from "./handoff";
export { SiftFocusStatus, SiftScrollHandoffCue } from "./handoff";
export type {
  ArrowStreamManifest,
  ArrowStreamManifestChunk,
  ArrowStreamSummary,
  SiftLoadMilestone,
  SiftSource,
  SiftTableHandle,
  SiftTableProps,
} from "./react";
// React component
export { SiftTable, URL_PARQUET_LIMITS, useSiftEngine } from "./react";
export type {
  BooleanColumnSummary,
  BooleanFilter,
  CategoricalColumnSummary,
  Column,
  ColumnFileStats,
  ColumnFilter,
  ColumnSummary,
  ColumnType,
  Coverage,
  DataScope,
  DatasetCoverage,
  MetricPrecision,
  MetricSource,
  NumericColumnSummary,
  RangeFilter,
  ReplaceDataOptions,
  ScopedValue,
  SetFilter,
  SummaryScope,
  TableData,
  TableEngine,
  TableEngineOptions,
  TableEngineState,
  TimestampColumnSummary,
} from "./table";
// Imperative engine
export { createTable } from "./table";
// WASM configuration
export { setWasmUrl } from "./predicate";
