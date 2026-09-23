# Preview Python

Experimental compute provider exclusively for explicitly enabled celld cloud
notebooks. Do not enable for Desktop or generic Cloudflare deployments.

Keep cloud credentials and runtime-peer authority outside the Python isolate.
One loaded isolate/interpreter belongs to one notebook runtime session. Never
return a used interpreter to the clean pool. The room owns execution intent;
the machine adapter in `packages/pyodide-runtime` receives only room-accepted
source, cell IDs, and execution IDs.

Real celld integration tests must own isolated storage and processes. Never use
or modify the separate celld Python Workers experiment's running services.
Pinned runtime artifacts may be reused read-only. Record provenance and hashes.

Run the root-required cargo xtask lint --fix before commits. Keep observable
experimental limitations in README.md; task progress lives in .context/.
