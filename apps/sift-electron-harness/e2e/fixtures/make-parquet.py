"""Write the harness's Parquet fixtures.

    uv run --with pyarrow python e2e/fixtures/make-parquet.py <out-dir>

- small.parquet: 4 rows, one row group.
- big.parquet: 96 row groups x 1,024 rows (98,304 rows, about 75 MB) with an
  int64 id, a boolean `active`, a float64 `value`, a UTC timestamp, and a
  wrapped high-entropy text column. The text is random base64 broken into
  76-character lines, so it neither compresses nor dictionary-encodes and
  each row is several lines tall.

Deterministic (seeded); existing files are left alone.
"""

import base64
import os
import random
import sys
from datetime import datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq

ROW_GROUPS = 96
ROWS_PER_GROUP = 1024
TEXT_BYTES = 570  # 760 base64 characters before wrapping


def wrapped(raw: bytes) -> str:
    text = base64.b64encode(raw).decode("ascii")
    return "\n".join(text[i : i + 76] for i in range(0, len(text), 76))


def batch(rng: random.Random, start: int, rows: int) -> pa.RecordBatch:
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = list(range(start + 1, start + rows + 1))
    return pa.record_batch(
        {
            "id": pa.array(ids, pa.int64()),
            "active": pa.array([i % 3 != 0 for i in ids], pa.bool_()),
            "value": pa.array([rng.gauss(100.0, 25.0) for _ in ids], pa.float64()),
            "ts": pa.array(
                [base + timedelta(seconds=37 * i) for i in ids], pa.timestamp("us", tz="UTC")
            ),
            "text": pa.array([wrapped(rng.randbytes(TEXT_BYTES)) for _ in ids], pa.string()),
        }
    )


def write(path: str, groups: int, rows_per_group: int) -> None:
    if os.path.exists(path):
        return
    rng = random.Random(4497)
    tmp = f"{path}.tmp"
    first = batch(rng, 0, rows_per_group)
    with pq.ParquetWriter(
        tmp, first.schema, compression="snappy", use_dictionary=["active"]
    ) as writer:
        writer.write_batch(first, row_group_size=rows_per_group)
        for group in range(1, groups):
            writer.write_batch(
                batch(rng, group * rows_per_group, rows_per_group), row_group_size=rows_per_group
            )
    os.replace(tmp, path)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else ".cache"
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, "small.parquet"), 1, 4)
    write(os.path.join(out, "big.parquet"), ROW_GROUPS, ROWS_PER_GROUP)
    for name in ("small.parquet", "big.parquet"):
        path = os.path.join(out, name)
        meta = pq.ParquetFile(path).metadata
        size = os.path.getsize(path)
        print(f"{path}: {size:,} bytes, {meta.num_rows:,} rows, {meta.num_row_groups} row groups")


if __name__ == "__main__":
    main()
