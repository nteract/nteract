// A CSV file as Arrow IPC: the one conversion every CSV reader on a Page
// goes through, called by normalized-bytes.mjs once per asset from the
// source store's byte cache. A module view's csv(), a chart and a dataframe
// table read the Arrow IPC it returns. @nteract/sift-csv parses the bytes in
// its own WASM; module-csv.mjs points it at that WASM in the viewer.
//
// What a reader gets, from Sift's CSV parser:
// - The first row is always the header. Only a comma separates fields, and
//   the file must be UTF-8 (a leading byte-order mark is skipped).
// - Each column has one type, inferred from every row: booleans (true/false
//   in any case), 64-bit integers, floats (exponents included), ISO dates,
//   ISO timestamps (one with no zone is UTC), else text. A column of digits,
//   such as postal codes, is numbers, so a leading zero is lost.
// - An empty field is null in every type.
// - A ragged row, invalid UTF-8 or a crossed limit is an error. Nothing is
//   truncated or sampled.
import { csvToArrowIpc } from "@nteract/sift-csv";
import { CSV_UNREADABLE } from "./sift-dataset.mjs";

/** CSV `bytes` as one Arrow IPC stream, within `limits` (sift-dataset.mjs
 * DATAFRAME_LIMITS: maxBytes, maxRows, maxColumns, maxDecodedBytes). A file
 * that does not parse, or crosses a limit, rejects with a CsvUnreadable
 * error whose message says why. */
export async function csvArrow(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes }) {
  try {
    return await csvToArrowIpc(bytes, {
      maxBytes,
      maxRows,
      maxColumns,
      maxOutputBytes: maxDecodedBytes,
    });
  } catch (error) {
    // The parser rejects with its reason as a string. Anything else, such as
    // a WASM that failed to load, is not about this file.
    if (typeof error !== "string") throw error;
    const unreadable = Error(
      `This file can't be read as CSV: ${error.replace(/^Csv error: /, "")}`.slice(0, 240),
    );
    unreadable.name = CSV_UNREADABLE;
    throw unreadable;
  }
}
