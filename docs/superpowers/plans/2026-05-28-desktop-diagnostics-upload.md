# Desktop Diagnostics Upload Plan

## Goal

Add a desktop-only `Help > Send Logs to Developer...` flow that prepares the existing `runt diagnostics` archive and uploads it anonymously to the deployed diagnostics service:

`https://diagnostics.runtimed.com/v1/diagnostics/uploads`

## Scope

- Add a native Help menu item that opens a standalone diagnostics window.
- Reuse the bundled `runt` CLI diagnostics archive so the uploaded bundle matches the existing support artifact.
- Keep upload implementation in Rust/Tauri so the webview does not need direct network access to the diagnostics origin.
- Require a user click before upload, show archive size and included file names, warn above the deployed warning threshold, and return the diagnostic token after upload.
- Avoid the feedback flow for this first iteration.

## Implementation Steps

1. Add a Rust diagnostics upload module with:
   - temporary archive preparation through bundled `runt diagnostics --output`
   - per-window prepared archive state
   - create-upload-slot POST and archive PUT
   - platform/channel metadata matching the deployed API
2. Add Tauri commands:
   - `prepare_diagnostics_archive`
   - `upload_prepared_diagnostics`
   - `cleanup_prepared_diagnostics`
3. Add `Help > Send Logs to Developer...` and a singleton diagnostics webview.
4. Add `apps/notebook/diagnostics` as a compact React entrypoint.
5. Add focused tests for API metadata/path helpers and archive listing behavior.

## Verification

- `cargo test -p notebook diagnostics_upload`
- `cargo check -p notebook`
- `pnpm --dir apps/notebook build`
- `cargo xtask lint --fix`
