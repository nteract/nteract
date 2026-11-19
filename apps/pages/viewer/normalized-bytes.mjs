// The one place a source version's media type decides how a table reader
// gets its bytes. Every table reader on a Page (a dataframe table, a chart,
// a module view's parquet() and csv()) reads through normalizedBytes, and
// none of them looks at the media type to choose a decoder:
// - a Parquet version gives its bytes unchanged;
// - a CSV version gives one Arrow IPC stream, converted by csv-arrow.mjs;
// - with `asCsv`, a version of any media type is converted as CSV, for a
//   module view's csv() on a file uploaded as generic binary.
// So a caller must accept either Parquet or Arrow IPC. Sift's loadTableFile
// and view-arrow.mjs decodeArrow tell them apart by the Parquet magic bytes.
import { CSV_MEDIA_TYPE, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

// The CSV converter's chunk, loaded the first time a Page reads a CSV.
const loadCsvArrow = () => import("./module-csv.mjs").then((m) => m.csvArrow);

/** How normalizedBytes reads `version`: "parquet", "csv", or null for a
 * media type no table reader takes. Lets a reader refuse before fetching. */
export function normalizedForm(version, { asCsv = false } = {}) {
  if (asCsv || version?.media_type === CSV_MEDIA_TYPE) return "csv";
  return version?.media_type === PARQUET_MEDIA_TYPE ? "parquet" : null;
}

/** The bytes a table reader decodes for `version`, given its stored `bytes`:
 * Parquet unchanged, or a CSV as Arrow IPC within `limits` (sift-dataset.mjs
 * DATAFRAME_LIMITS). A CSV that does not parse, or crosses a limit, rejects
 * with a CsvUnreadable error that says why. `csvArrow()` resolves with the
 * converter; tests pass csv-arrow.mjs's own. */
export async function normalizedBytes(
  version,
  bytes,
  limits,
  { asCsv = false, csvArrow = loadCsvArrow } = {},
) {
  const form = normalizedForm(version, { asCsv });
  if (form === "parquet") return bytes;
  if (form === "csv") return (await csvArrow())(bytes, limits);
  throw Error(`This build can't show ${version?.media_type}.`);
}
