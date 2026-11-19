// Small Parquet files for module views, written in memory by Sift's own
// Parquet writer from an apache-arrow table. Unit tests and
// scripts/output-smoke.mjs both read them, so neither commits a binary.
//
// One row per day from 2026-11-01, `days` rows:
// - day: date32
// - at: timestamp, microseconds, UTC (noon of that day)
// - at_ms: timestamp, milliseconds, UTC (noon of that day)
// - people: int64, every value safe as a number
// - name: utf8, null on the second row
// - score: float64, null on every third row
// - big: int64, only with `unsafe`: 2^60 on the last row
import "#sift-wasm";
import { write_parquet_ipc } from "@nteract/sift/wasm";
import {
  DateDay,
  Float64,
  Table,
  TimestampMicrosecond,
  TimestampMillisecond,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";

export const FIRST_DAY_MS = Date.UTC(2026, 10, 1);
const DAY_MS = 86_400_000;

export function parquetFixture({
  days = 7,
  people = (i) => 3 + ((i * 5) % 11),
  unsafe = false,
} = {}) {
  const rows = Array.from({ length: days }, (_, i) => i);
  const firstDay = FIRST_DAY_MS / DAY_MS;
  const noon = (i) => FIRST_DAY_MS + i * DAY_MS + DAY_MS / 2;
  const columns = {
    day: makeVector(
      makeData({
        type: new DateDay(),
        length: days,
        data: Int32Array.from(rows, (i) => firstDay + i),
      }),
    ),
    at: makeVector(
      makeData({
        type: new TimestampMicrosecond("UTC"),
        length: days,
        data: BigInt64Array.from(rows, (i) => BigInt(noon(i)) * 1000n),
      }),
    ),
    at_ms: makeVector(
      makeData({
        type: new TimestampMillisecond("UTC"),
        length: days,
        data: BigInt64Array.from(rows, (i) => BigInt(noon(i))),
      }),
    ),
    people: makeVector(BigInt64Array.from(rows, (i) => BigInt(people(i)))),
    name: vectorFromArray(
      rows.map((i) => (i === 1 ? null : `day ${i + 1}`)),
      new Utf8(),
    ),
    score: vectorFromArray(
      rows.map((i) => (i % 3 === 2 ? null : i / 2)),
      new Float64(),
    ),
    ...(unsafe && {
      big: makeVector(BigInt64Array.from(rows, (i) => (i === days - 1 ? 2n ** 60n : BigInt(i)))),
    }),
  };
  return write_parquet_ipc(tableToIPC(new Table(columns)));
}
