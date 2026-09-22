# Automatic preview lifecycle check

This test-only PR checks the ordinary PR preview workflow from `main`.
The initial revision changes documentation only. After saving a notebook in its
preview, a later revision will add a visible application marker so we can verify
that the update keeps the notebook and preview URL. Closure and reopening will
check cleanup and retained notebook state. Close this PR without merging it.

Initial marker: `automatic-preview-lifecycle-2026-09-22`.
