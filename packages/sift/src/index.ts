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
export type { TableFileOptions } from "./file-data";
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
export { SiftTable, useSiftEngine } from "./react";
export type {
  BooleanColumnSummary,
  BooleanFilter,
  CategoricalColumnSummary,
  Column,
  ColumnFilter,
  ColumnSummary,
  ColumnType,
  NumericColumnSummary,
  RangeFilter,
  ReplaceDataOptions,
  SetFilter,
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
