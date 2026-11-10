-- Pages usage by day × person × surface × client × model.
--
-- Reads pages.usage.v1 lines (worker/usage.mjs) from celld's OTel log Parquet.
-- celld stores each Worker console line as the `body` column of a log record.
-- A usage body is one JSON object. Other Worker lines need not be JSON.
-- Usage, with credentials for the fleet bucket in the environment:
--
--   duckdb -c "SET VARIABLE logs = 's3://<fleet-bucket>/<fleet-prefix>/telemetry/logs/**/*.parquet';" \
--          -f scripts/usage-report.sql
--
-- Counts: tool_calls are tool calls on /mcp and /api/tools. resource_calls
-- are MCP resource lists and reads. pages_created counts each created Page
-- once (a replayed receipt records none), from agents and from the browser.
-- sync_sessions counts admitted browser sync sessions. refused_syncs counts
-- refused admissions.
INSTALL httpfs; LOAD httpfs;
INSTALL json; LOAD json;
CREATE OR REPLACE SECRET (TYPE s3, PROVIDER credential_chain);

WITH usage AS (
  SELECT CAST(body AS JSON) AS e
  FROM read_parquet(getvariable('logs'), union_by_name = true)
  WHERE json_valid(body) AND body->>'event' = 'pages.usage.v1'
),
calls AS (
  SELECT *, coalesce(e->>'kind', 'tool') AS kind FROM usage
)
SELECT
  CAST(CAST(e->>'timestamp' AS TIMESTAMP) AS DATE) AS day,
  coalesce(e->>'display_name', e->>'principal', '(anonymous)') AS person,
  e->>'surface' AS surface,
  coalesce(e->>'client', e->>'driver', '(undeclared)') AS client,
  coalesce(e->>'model', '(undeclared)') AS model,
  count(*) FILTER (WHERE e->>'action' = 'tool.call' AND kind = 'tool') AS tool_calls,
  count(*) FILTER (WHERE e->>'action' = 'tool.call' AND kind = 'resource') AS resource_calls,
  count(*) FILTER (WHERE e->>'action' = 'page.create') AS pages_created,
  count(*) FILTER (WHERE e->>'action' = 'sync.open' AND e->>'admitted' = 'true') AS sync_sessions,
  count(*) FILTER (WHERE e->>'action' = 'sync.open' AND e->>'admitted' = 'false') AS refused_syncs,
  count(*) FILTER (WHERE e->>'action' = 'mcp.initialize') AS mcp_sessions,
  count(*) FILTER (WHERE e->>'action' = 'tool.call' AND kind = 'tool' AND e->>'outcome' <> 'ok') AS tool_errors,
  round(median(CAST(e->>'latency_ms' AS DOUBLE)) FILTER (WHERE e->>'action' = 'tool.call' AND kind = 'tool')) AS p50_tool_ms
FROM calls
GROUP BY ALL
ORDER BY day DESC, person, surface, client, model;
