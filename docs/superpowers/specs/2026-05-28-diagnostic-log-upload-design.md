# Diagnostic Log Upload Design

## Summary

Add an opt-in diagnostic upload path behind a new
`Help > Send Logs to Developer...` menu item. The desktop app will create an
expanded diagnostics archive locally, ask a Cloudflare Worker on a
`runtimed.com` subdomain for an anonymous upload slot, upload the archive to a
private R2 bucket, and show the returned diagnostic token to the user.

The v1 goal is faster support triage for sparse reports like "Something went
wrong" while keeping the upload capability narrow enough for a small team to
operate safely.

## Goals

- Let users attach useful app, daemon, and MCP logs without manually finding log
  files.
- Keep uploads anonymous and low friction.
- Store diagnostics privately with short retention.
- Apply abuse controls before accepting archive data.
- Avoid requiring a full feedback or GitHub issue flow before the user can send
  logs.

## Non-Goals

- No public diagnostic links in v1.
- No user accounts, OAuth, or GitHub identity binding.
- No automatic upload on crash or error boundary entry.
- No full cache dump without filtering.
- No cloud-side log parsing or redaction pipeline in v1.
- No requirement that the user opens a GitHub issue.
- No GitHub issue creation from the log upload flow in v1.

## Current Context

The app already has a Help menu with `Send Feedback...`, backed by
`apps/notebook/feedback/`. That flow collects a message, app/system metadata
from `get_feedback_system_info`, and opens a prefilled GitHub issue.

The log-upload v1 should be a separate Help menu action so a user can send logs
without first writing a report:

- `Help > Send Feedback...` keeps the current GitHub issue flow.
- `Help > Send Logs to Developer...` opens the diagnostics upload flow.
- A later iteration can connect the two by offering to paste a diagnostic token
  into a GitHub issue.

The CLI already has `runt diagnostics`, which creates a `.tar.gz` containing:

- `runtimed.log` and `runtimed.log.1`
- `notebook.log` and `notebook.log.1`
- the 10 most recent `mcp-logs/*.log`
- `daemon-status.json`
- `doctor.json`
- `system-info.json`

Local sizing from this machine on May 28, 2026:

| Sample | Files | Raw Size | Compressed Size |
| --- | ---: | ---: | ---: |
| Stable `runt diagnostics` | 17 | 203,691 bytes | 10,967 bytes |
| Nightly `runt-nightly diagnostics` | 17 | 640,485 bytes | 31,987 bytes |
| All stable cache logs | 253 | 1,606,443 bytes | 91,612 bytes |
| All nightly cache logs | 45 | 1,966,262 bytes | 131,515 bytes |

The largest single local log was 382,414 bytes. A 50 MB upload cap leaves room
for much noisier user sessions while staying below Cloudflare's documented
100 MB request body limit for Free/Pro plans.

## User Experience

The Help menu adds:

- `Send Logs to Developer...`

The menu item opens a small upload window or modal with:

- A short explanation of what will be collected.
- A short disclosure explaining that logs may contain local paths, environment
  names, package names, and error messages.
- A "View archive contents" affordance after the archive is prepared.
- Upload progress and a retryable failure state.
- A final success state that shows the diagnostic token and a copy button.

Default state:

- No archive is created until the user confirms the upload.
- If the upload succeeds, the window shows:
  `Diagnostic upload: diag_YYYYMMDD_<shortid>`
- The user can copy the token and paste it into GitHub, Discord, email, or any
  existing support conversation.
- If the upload fails, the window shows a concise failure message and offers
  retry when appropriate.

Follow-up integration:

- The existing feedback window may later offer `Attach uploaded diagnostics...`
  or `Include new diagnostic upload`, but that is not required for v1.

## Desktop Responsibilities

Add a Tauri command for diagnostics upload:

1. Build an expanded diagnostics archive in a temporary location.
2. Estimate compressed size before upload.
3. Enforce the app-side 25 MB warning threshold.
4. Ask the Worker for an upload slot.
5. Upload the archive.
6. Delete the temporary archive after success, cancellation, or failure.
7. Return the diagnostic token to the upload UI.

Add native menu wiring:

- New menu item ID: `send_logs_to_developer`.
- Label: `Send Logs to Developer...`.
- Location: Help menu, near `Send Feedback...`.
- Behavior: open/focus a singleton diagnostics upload window.

The archive should include the existing `runt diagnostics` contents plus recent
channel logs from the same cache root:

- `*.log`, `*.log.1`, and `daemon.json`
- current channel only (`runt` or `runt-nightly`)
- max age: 14 days
- max files: 250
- preserve relative paths under a normalized root such as `logs/...`

The archive must avoid embedding absolute home paths in tar member names.

## Cloudflare Ingest Service

Deploy a Worker at:

- `https://diagnostics.runtimed.com`

Endpoints:

- `POST /v1/uploads`
  - Input: app version, commit, platform, archive size, source flow, and a
    random client nonce.
  - Output: upload ID, diagnostic token, upload URL, accepted size limit, and
    expiry.

- `PUT /v1/uploads/:id`
  - Input: `application/gzip` or `application/x-gzip` body.
  - Validates the upload ID, expiry, one-use state, content length, and rate
    limits.
  - Writes the object to private R2.

- `GET /v1/uploads/:id/status`
  - Optional v1 convenience endpoint for app retries and user-visible status.

Use Worker R2 bindings for v1 instead of exposing R2 presigned URLs. R2
presigned URLs are bearer tokens and Cloudflare documents that they work with
the R2 S3 API domain, not custom domains. A Worker upload endpoint keeps the
public API on `runtimed.com`, lets us validate metadata before accepting data,
and gives us a single place for rate limiting and abuse controls.

R2 object keys:

```text
diagnostics/YYYY/MM/DD/diag_YYYYMMDD_<random>.tar.gz
```

R2 custom metadata:

- diagnostic token
- app version
- commit SHA
- platform
- archive byte size
- creation timestamp
- rough source metadata needed for support triage

Do not store raw IP addresses in object metadata. If per-IP abuse tracking is
needed, store a short-lived keyed hash in KV or Durable Object state.

## Abuse Controls

Apply layered controls:

- Worker Rate Limiting binding on both slot creation and upload.
- Per-IP or per-IP-hash limits:
  - slot creation: 5 attempts per minute
  - upload attempts: 3 attempts per minute
  - successful uploads: 10 per day via KV or Durable Object counters
- Global daily upload byte cap: 5 GB, with an environment-variable kill switch.
- One upload per issued ID.
- Upload slot TTL: 15 minutes.
- Accepted content types: gzip tar archive only.
- Hard Worker reject over 50 MB.
- App-side warning over 25 MB.
- Private R2 bucket, no public read route.

Turnstile is not required in v1. Add it only if abuse appears or if the public
endpoint starts receiving automated upload attempts. If added later, validate
Turnstile tokens server-side before issuing upload slots.

## Retention

Retain uploads for 30 days, then delete automatically.

Implementation options:

- Lifecycle rule on the R2 bucket if available for the deployed account.
- Scheduled Worker cleanup if lifecycle configuration is not sufficient.

The diagnostic token remains useful only while the object exists.

## Privacy

The upload UI must make the privacy tradeoff explicit:

- Logs can include local filesystem paths.
- Logs can include environment names, package names, command output, and error
  messages.
- Notebook contents are not intentionally included.
- The user can continue without logs.

No automatic upload is permitted in v1.

## Error Handling

Desktop:

- Archive creation failure: show local error and do not contact the Worker.
- Upload slot rejected by rate limit: show a calm "try again later" message.
- Upload body rejected by size: show the size and the server limit.
- Network failure: allow retry while the slot remains valid; otherwise request
  a new slot.

Worker:

- Return structured JSON errors with stable `code` fields.
- Return `429` for rate limits.
- Return `413` for size limit.
- Return `410` for expired upload slots.
- Return `409` for reused upload slots.

## Testing

Desktop tests:

- Archive builder includes expected current diagnostics files.
- Archive builder includes recent channel logs without absolute home paths.
- Archive builder respects age and file-count caps.
- Help menu contains `Send Logs to Developer...`.
- The diagnostics upload window displays the diagnostic token after a successful
  upload.
- The diagnostics upload window handles archive and upload failures without
  opening GitHub or losing the user's ability to retry.

Worker tests:

- Slot creation validates metadata and limits.
- Upload rejects oversized objects.
- Upload rejects expired and reused IDs.
- Upload writes expected R2 key and metadata.
- Rate-limited requests return `429`.

Manual verification:

- Upload diagnostics from stable and nightly through
  `Help > Send Logs to Developer...`.
- Confirm R2 object is private.
- Confirm token appears in the upload success state and can be copied.
- Confirm archive can be retrieved by an internal operator path.
- Confirm old uploads are deleted after retention.

## Open Decisions

- Internal operator retrieval is dashboard-only in v1. A small authenticated
  admin endpoint can be added after the upload workflow proves useful.

## References

- Cloudflare R2 presigned URLs:
  https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Cloudflare R2 Workers API:
  https://developers.cloudflare.com/r2/api/workers/
- Cloudflare Workers request limits:
  https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers Rate Limiting binding:
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Turnstile server-side validation:
  https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
