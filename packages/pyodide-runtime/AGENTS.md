# Pyodide runtime

This package owns the isolated Python machine: pinned interpreter/package assets,
IPython semantics, the celld dynamic-worker adapter, result validation, deadlines,
and host-confirmed termination. It has no notebook room credentials or Automerge
write authority. The service in `apps/preview-python` owns admission and runtime
peer lifecycle.

Execute only source accepted by the notebook coordinator. Preserve `cell_id`,
`execution_id`, and accepted source identity across the machine boundary. Guest
output remains untrusted data; do not accept internal blob/widget references or
document patches. Never reuse a tenant interpreter as a clean standby.

Use isolated test-owned celld instances for integration checks. Leave the separate
celld Python Workers experiment and live fleet processes alone. The Node Pyodide
compatibility tests verify Python behavior, not celld isolation or scheduling.
