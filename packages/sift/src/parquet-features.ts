/**
 * Shared parsers for parquet schema KV metadata.
 *
 * Two emitters write rich-type hints into the parquet footer that Sift
 * consumes:
 *
 * - HuggingFace datasets stash a JSON ``huggingface`` key naming each
 *   feature (Image, ClassLabel, Translation, …). Sift uses this to
 *   render thumbnails, narrow types, and skip pointless sort handles.
 * - pandas writes an ``index_columns`` list under the ``pandas`` key so
 *   we can label and size the row-index column reasonably.
 *
 * Both consumers (the standalone demo's ``main.ts`` loader and the
 * embedded ``SiftTable`` URL path) need the same parsing + apply logic.
 * Keep them lockstep here.
 */

import type { Column } from "./table";

export interface HfFeature {
  _type: string;
  names?: string[];
  feature?: HfFeature;
}

export type SchemaMetadata = Record<string, string>;

/**
 * The wasm-bindgen ``parquet_schema_metadata`` result lands in JS as a
 * ``Map<string,string>`` (because the Rust side returns a ``HashMap``).
 * Property access on a Map returns ``undefined`` for every key, which
 * has silently broken HF detection in the past. Coerce to a record so
 * the rest of the pipeline can read keys with ordinary syntax.
 */
export function parseSchemaMetadata(raw: unknown): SchemaMetadata {
  if (raw instanceof Map) return Object.fromEntries(raw as Map<string, string>);
  if (raw && typeof raw === "object") return raw as SchemaMetadata;
  return {};
}

export function parseHfFeatures(metadata: SchemaMetadata): Record<string, HfFeature> {
  if (!metadata.huggingface) return {};
  try {
    const hf = JSON.parse(metadata.huggingface);
    return (hf?.info?.features ?? {}) as Record<string, HfFeature>;
  } catch {
    return {};
  }
}

export function parsePandasIndexColumns(metadata: SchemaMetadata): Set<string> {
  const out = new Set<string>();
  if (!metadata.pandas) return out;
  try {
    const pandas = JSON.parse(metadata.pandas);
    for (const ic of pandas.index_columns ?? []) {
      if (typeof ic === "string") out.add(ic);
      // Range-index descriptors (objects) don't map to a named column.
    }
  } catch {
    /* ignore parse errors */
  }
  return out;
}

const PANDAS_INDEX_LABEL_PATTERN = /^(unnamed[: _]*\d*|__index_level_\d+__)$/i;
const INDEX_NAME_PATTERN = /^(unnamed[: _]*\d*|index|_?id|rowid|row_?id|row_?num)$/i;

/**
 * Narrow + de-sort columns that look like a row index. ``totalRows``
 * sizes the column to fit the largest displayed row number.
 */
export function applyPandasIndexOverrides(
  columns: Column[],
  pandasIndexCols: Set<string>,
  totalRows: number,
): void {
  for (const col of columns) {
    if (!pandasIndexCols.has(col.key) && !INDEX_NAME_PATTERN.test(col.key)) continue;
    const digits = totalRows.toLocaleString().length;
    col.width = Math.max(60, digits * 9 + 24);
    col.sortable = false;
    if (PANDAS_INDEX_LABEL_PATTERN.test(col.key)) col.label = "";
  }
}

/**
 * Narrow column types based on HuggingFace feature declarations.
 *
 * ``ClassLabel`` → categorical. ``Image`` and ``List<Image>`` /
 * ``Sequence<Image>`` → image with a wider min-width when it's a strip.
 */
export function applyHfFeatureOverrides(
  columns: Column[],
  hfFeatures: Record<string, HfFeature>,
): void {
  for (const col of columns) {
    const feature = hfFeatures[col.key];
    if (!feature) continue;

    if (feature._type === "ClassLabel" && col.columnType !== "categorical") {
      col.columnType = "categorical";
      col.numeric = false;
    }

    const inner =
      feature._type === "Image"
        ? feature
        : feature._type === "List" || feature._type === "Sequence"
          ? feature.feature
          : undefined;
    if (inner?._type === "Image") {
      col.columnType = "image";
      col.numeric = false;
      col.sortable = false;
      const isList = feature._type !== "Image";
      const minWidth = isList ? 320 : 140;
      if (col.width < minWidth) col.width = minWidth;
    }
  }
}
