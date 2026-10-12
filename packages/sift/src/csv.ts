import { BooleanAccumulator, CategoricalAccumulator, NumericAccumulator } from "./accumulators";
import { autoWidth } from "./auto-width";
import type { Column, ColumnSummary, ColumnType, TableData } from "./table";

export type CsvParseOptions = {
  /** Explicit delimiter. No delimiter or encoding guessing is performed. */
  delimiter?: "," | ";" | "\t" | "|";
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
  /** Infer whole-column numbers/booleans, or preserve every non-null field as text. */
  typing?: "text" | "infer";
};

type CsvCell = string | null;

function limit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function inferType(values: CsvCell[]): ColumnType {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) return "categorical";
  if (present.every((value) => value === "true" || value === "false")) return "boolean";
  if (
    present.every((value) => {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return false;
      const number = Number(value);
      const mantissa = value.split(/[eE]/)[0].replace(/[-.]/g, "");
      if (number === 0 && /[1-9]/.test(mantissa)) return false;
      const significantDigits = mantissa.replace(/^0+/, "").length;
      if (significantDigits > 15 && /[.eE]/.test(value)) return false;
      return Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number));
    })
  ) {
    return "numeric";
  }
  return "categorical";
}

function summarize(type: ColumnType, raw: unknown[], strings: string[]): ColumnSummary {
  const accumulator =
    type === "numeric"
      ? new NumericAccumulator()
      : type === "boolean"
        ? new BooleanAccumulator()
        : new CategoricalAccumulator(strings);
  accumulator.add(raw, 0, raw.length);
  return accumulator.snapshot(raw.length);
}

/**
 * Parse one complete, bounded CSV document for Sift. The first record is the
 * header. Empty unquoted fields are null; quoted empty fields and tokens such as
 * NA/null remain text. Blank/duplicate headers receive unique display names.
 * Quoting and record widths are strict: malformed or over-limit input fails
 * instead of returning a truncated table. Hosts own file access and decoding.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): TableData {
  const maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, "maxBytes");
  const maxRows = limit(options.maxRows, 100_000, "maxRows");
  const maxColumns = limit(options.maxColumns, 256, "maxColumns");
  const maxCells = limit(options.maxCells, 1_000_000, "maxCells");
  const delimiter = options.delimiter ?? ",";
  if (![",", ";", "\t", "|"].includes(delimiter)) throw new Error("Unsupported CSV delimiter.");
  if (options.typing !== undefined && options.typing !== "text" && options.typing !== "infer") {
    throw new Error("Unsupported CSV typing mode.");
  }
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`CSV exceeds the ${maxBytes}-byte limit.`);
  }

  const rows: CsvCell[][] = [];
  let headers: string[] | undefined;
  let record: CsvCell[] = [];
  let fieldStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let fieldEnd = fieldStart;
  let quoted = false;
  let inQuotes = false;
  let closedQuote = false;
  let recordStarted = false;

  function finishField(end: number) {
    if (record.length >= maxColumns) throw new Error(`CSV exceeds the ${maxColumns}-column limit.`);
    const field = quoted
      ? text.slice(fieldStart, fieldEnd).replace(/""/g, '"')
      : text.slice(fieldStart, end);
    record.push(field === "" && !quoted ? null : field);
    fieldStart = end + 1;
    quoted = false;
    closedQuote = false;
  }

  function finishRecord(end: number) {
    finishField(end);
    if (!headers) {
      const seen = new Set<string>();
      headers = record.map((value, index) => {
        const name = value || `Column ${index + 1}`;
        let unique = name;
        for (let suffix = 2; seen.has(unique); suffix++) unique = `${name} (${suffix})`;
        seen.add(unique);
        return unique;
      });
    } else {
      if (record.length !== headers.length) {
        throw new Error(
          `CSV record ${rows.length + 2} has ${record.length} fields; expected ${headers.length}.`,
        );
      }
      if (rows.length >= maxRows) throw new Error(`CSV exceeds the ${maxRows}-row limit.`);
      if ((rows.length + 1) * headers.length > maxCells) {
        throw new Error(`CSV exceeds the ${maxCells}-cell limit.`);
      }
      rows.push(record);
    }
    record = [];
    recordStarted = false;
  }

  for (let i = fieldStart; i < text.length; i++) {
    const char = text[i];
    recordStarted = true;
    if (inQuotes) {
      if (char !== '"') continue;
      if (text[i + 1] === '"') {
        i++;
      } else {
        inQuotes = false;
        closedQuote = true;
        fieldEnd = i;
      }
    } else if (char === delimiter) {
      finishField(i);
    } else if (char === "\r" || char === "\n") {
      finishRecord(i);
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
        fieldStart = i + 1;
      }
    } else if (closedQuote) {
      throw new Error(
        `Unexpected character after a closing quote in CSV record ${rows.length + (headers ? 2 : 1)}.`,
      );
    } else if (char === '"') {
      if (i !== fieldStart) throw new Error("Unexpected quote in an unquoted CSV field.");
      quoted = true;
      inQuotes = true;
      fieldStart = i + 1;
    }
  }
  if (inQuotes) throw new Error("Unterminated quoted CSV field.");
  if (recordStarted) finishRecord(text.length);

  const rawColumns: unknown[][] = [];
  const summaries: TableData["columnSummaries"] = [];
  const columns: Column[] = (headers ?? []).map((name, col) => {
    const values = rows.map((row) => row[col]);
    const columnType = options.typing === "text" ? "categorical" : inferType(values);
    const raw = values.map((value) => {
      if (value === null) return null;
      if (columnType === "numeric") return Number(value);
      if (columnType === "boolean") return value === "true";
      return value;
    });
    rawColumns.push(raw);
    summaries.push(
      summarize(
        columnType,
        raw,
        values.map((value) => value ?? ""),
      ),
    );
    return {
      key: name,
      label: name,
      columnType,
      numeric: columnType === "numeric",
      sortable: true,
      width: autoWidth(name, columnType),
    };
  });

  const data: TableData = {
    columns,
    rowCount: rows.length,
    getCell: (row, col) => rows[row]?.[col] ?? "",
    getCellRaw: (row, col) => rawColumns[col]?.[row] ?? null,
    columnSummaries: summaries,
    recomputeFilteredSummaries(mask) {
      data.columnSummaries = columns.map((column, col) => {
        const raw: unknown[] = [];
        const strings: string[] = [];
        for (let row = 0; row < rows.length; row++) {
          if (mask[row]) {
            raw.push(rawColumns[col][row]);
            strings.push(rows[row][col] ?? "");
          }
        }
        return summarize(column.columnType, raw, strings);
      });
    },
  };
  return data;
}
