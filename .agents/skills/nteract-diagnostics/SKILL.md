---
name: nteract-diagnostics
description: Pull and triage submitted nteract diagnostics archives from Cloudflare using a diagnostics id/token. Use when investigating "submit logs" reports, runtimed/notebook/MCP diagnostic archives, telemetry diagnostics uploads, or failures where the user gives an id and token.
---

# Nteract Diagnostics

Use this skill to fetch a diagnostics archive from the Cloudflare-backed nteract diagnostics service. You do not need the telemetry repo checkout; Wrangler access to the `Runt Prototype` Cloudflare account is enough.

Never include the diagnostics token in final output, issue comments, PR comments, logs you paste back, or committed files. The upload row query below intentionally does not select the token.

## Fetch Archive

Use a temporary directory outside the repo unless the user asks for durable repo-local artifacts.

```bash
export CLOUDFLARE_ACCOUNT_ID=1cfb529b94b3d6cde3aaf49d1d6ed5e6
export DIAG_ID="<paste id here>"
export DIAG_TOKEN="<paste token here>"

mkdir -p "/tmp/nteract-diag-$DIAG_ID"
cd "/tmp/nteract-diag-$DIAG_ID"

wrangler d1 execute telemetry --remote --json --command "
SELECT id, state, object_key, expected_size, uploaded_size, size_limit,
       app_version, commit_sha, platform, arch, channel, source_flow,
       created_at, expires_at, uploaded_at, retained_until
  FROM diagnostics_uploads
 WHERE id = '$DIAG_ID' AND token = '$DIAG_TOKEN'
 LIMIT 1;
" | tee upload-row.json
```

Check the row before fetching R2:

```bash
jq '.[0].results[0] // null' upload-row.json
export DIAG_STATE="$(jq -r '.[0].results[0].state // empty' upload-row.json)"
```

If no row is returned, report that the diagnostics reference was not found or the token did not match. If `DIAG_STATE` is not `uploaded`, report that state and stop.

When uploaded, fetch and extract the archive:

```bash
export OBJECT_KEY="$(jq -r '.[0].results[0].object_key // empty' upload-row.json)"

wrangler r2 object get "nteract-diagnostics/$OBJECT_KEY" --remote --file diagnostics.tar.gz
tar -tzf diagnostics.tar.gz | tee entries.txt
mkdir -p extracted
tar -xzf diagnostics.tar.gz -C extracted
```

If the installed Wrangler rejects `--remote` for `r2 object get`, retry the same command without `--remote`.

## Triage Workflow

Start with:

```bash
find extracted -maxdepth 3 -type f | sort
jq '.[0].results[0] | del(.token)' upload-row.json
```

Common archive files include:

- `runtimed.log`, `runtimed.log.1`: daemon lifecycle, kernel/env prep, room sync, crashes.
- `notebook.log`, `notebook.log.1`: desktop app and window-level behavior.
- `mcp-logs/*.log`: MCP tool calls, session connect/reconnect, sync readiness.
- `daemon-status.json`, `doctor.json`, `system-info.json`: health snapshot, runtime version, platform.

Search for high-signal evidence before broad log reading:

```bash
rg -n "ERROR|WARN|panic|timed out|timeout|Failed|failed|MissingOps|STARTUP|Daemon exited|Slow runt-mcp tool call|await_session_ready" extracted
```

Use timestamps to distinguish the reported incident from older noise. Convert Unix timestamps in `upload-row.json` when useful:

```bash
date -u -d "@$(jq -r '.[0].results[0].created_at' upload-row.json)"
date -u -d "@$(jq -r '.[0].results[0].uploaded_at' upload-row.json)"
```

## Report Shape

Return:

- Upload metadata from `upload-row.json`, excluding the token.
- Archive entries from `entries.txt`.
- Likely cause, with short evidence snippets and file references.
- Missing evidence or the next check if the archive does not cover the reported time window.

Do not overfit to the first scary error. Check whether the daemon was healthy at capture time, whether the logs include the reported timestamp, and whether later user messages make an earlier error a red herring.
