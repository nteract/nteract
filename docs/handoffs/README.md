# Handoffs

Handoffs are time-bound transfer notes. They preserve investigation context, but
they are not live architecture specs unless their current-status block says so.
When a handoff conflicts with a newer ADR, audit, runbook, or source file, prefer
the newer durable document or the source file and update the handoff status
instead of letting stale findings look current.

| File | Current use |
|------|-------------|
| [`16-decisions-log.md`](16-decisions-log.md) | Historical decision trail for the transport-agnostic runtime-agent and workstation attach work. Use its current status and later phase notes before treating early decisions as open backlog. |
| [`16-lifecycle-analysis.md`](16-lifecycle-analysis.md) | Historical lifecycle risk analysis. Partially superseded by the runtime-peer departure watchdog and reconnect work; remaining live gaps are called out at the top. |
| [`2026-06-01-host-convergence-deep-dive.md`](2026-06-01-host-convergence-deep-dive.md) | Historical deep dive on rejected local-first writes and recovery policy. Still useful as source evidence for sync-divergence recovery decisions. |
| [`2026-06-01-notebook-host-convergence.md`](2026-06-01-notebook-host-convergence.md) | Historical host-convergence handoff. Read with the deep dive and newer ADRs before treating rows as current work. |
| [`2026-06-26-og-ipynb-ttfc.md`](2026-06-26-og-ipynb-ttfc.md) | Active handoff for OG `.ipynb` TTFC benchmarking, Rust streaming-load drain evidence, and browser bootstrap review. |
