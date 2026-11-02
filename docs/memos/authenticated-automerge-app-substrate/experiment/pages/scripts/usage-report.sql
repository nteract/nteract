-- Pages usage by day × person × surface × client × model.
--
-- Reads pages.usage.v1 lines (worker/usage.mjs) from celld's OTel log Parquet.
-- celld stores each Worker console line as a log body; the body is one JSON
-- object. Usage, with credentials for the fleet bucket in the environment:
--
--   duckdb -c "SET VARIABLE logs = 's3://<fleet-bucket>/<fleet-prefix>/telemetry/logs/**/*.parquet';" \
--          -f pages/scripts/usage-report.sql
--
-- Check the body column name against one file first:
--   DESCRIBE SELECT * FROM read_parquet(getvariable('logs')) LIMIT 1;
-- The query below assumes `body`; change it here if celld names it otherwise.
INSTALL httpfs; LOAD httpfs;
INSTALL json; LOAD json;
CREATE OR REPLACE SECRET (TYPE s3, PROVIDER credential_chain);

WITH usage AS (
  SELECT CAST(body AS JSON) AS e
  FROM read_parquet(getvariable('logs'), union_by_name = true)
  WHERE CAST(body AS VARCHAR) LIKE '%"event":"pages.usage.v1"%'
)
SELECT
  CAST(CAST(e->>'timestamp' AS TIMESTAMP) AS DATE) AS day,
  coalesce(e->>'display_name', e->>'principal', '(anonymous)') AS person,
  e->>'surface' AS surface,
  coalesce(e->>'client', e->>'driver', '(undeclared)') AS client,
  coalesce(e->>'model', '(undeclared)') AS model,
  count(*) FILTER (WHERE e->>'action' = 'tool.call') AS tool_calls,
  count(*) FILTER (WHERE e->>'action' = 'page.create') AS pages_created,
  count(*) FILTER (WHERE e->>'action' = 'sync.open') AS sync_sessions,
  count(*) FILTER (WHERE e->>'action' = 'mcp.initialize') AS mcp_sessions,
  count(*) FILTER (WHERE e->>'action' = 'tool.call' AND e->>'outcome' <> 'ok') AS tool_errors,
  round(median(CAST(e->>'latency_ms' AS DOUBLE)) FILTER (WHERE e->>'action' = 'tool.call')) AS p50_tool_ms
FROM usage
GROUP BY ALL
ORDER BY day DESC, person, surface, client, model;
