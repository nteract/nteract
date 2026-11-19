# /// script
# dependencies = ["duckdb==1.4.3"]
# ///
"""Run with uv run fixture.py <output.parquet>."""
import sys

import duckdb

# The first 28 rows are one project's latest 28 days. More projects give
# Sift multiple row groups to skip when it opens a bounded preview.
duckdb.sql("""
    SELECT (i // 28)::integer AS project_id,
           strftime(DATE '2026-11-18' - (i % 28)::integer, '%b %d') AS day,
           (3 + hash(i) % 19)::integer AS active_people,
           md5(i::varchar) AS snapshot_id
    FROM range(84000) t(i)
""").write_parquet(sys.argv[1], compression="snappy", row_group_size=2048)
