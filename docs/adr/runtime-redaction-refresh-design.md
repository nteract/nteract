# Runtime Redaction Candidate Refresh Design

**Status:** Design memo.

## Context

The `[redact-opt]` daemon matcher optimizes the existing launch-time model:
collect eligible environment values when the kernel starts, then redact matching
text before RuntimeStateDoc or blob-store persistence. That remains the correct
durable boundary for all kernels, but it cannot see secrets created later inside
the kernel process by tools such as `python-dotenv`, SDK credential refreshers,
or Deno code that mutates process-local environment state.

The launcher-side cache keeps Python producer redaction cheap while preserving a
bounded refresh window. It reduces the cost of rescanning `os.environ`, but it is
still a Python-only producer defense. Non-Python kernels need a common way to add
runtime-created redaction candidates when they can observe them.

## Goals

- Preserve the daemon storage boundary as the final redaction authority.
- Let runtime producers report newly observed secret values without exposing
  secret names or values to frontend clients.
- Keep runtime refresh optional and best-effort; launch-time redaction remains
  the baseline.
- Avoid per-output full environment scans in the daemon or producer.
- Make Python dotenv-style loaders the first implementation target, with a path
  for Deno or other kernels.

## Non-Goals

- Do not try to infer arbitrary secrets from output text.
- Do not sync redaction candidates through NotebookDoc or RuntimeStateDoc.
- Do not expose redaction candidate lists through MCP, frontend state, or saved
  notebooks.
- Do not block the Aho-Corasick launch-time optimization on runtime refresh.

## Proposed Shape

Add an internal runtime-agent to daemon control message:

```text
RuntimeAgentEvent::AddRedactionCandidates {
    values: Vec<String>,
}
```

The daemon owns the canonical redaction candidate set for the kernel. When it
receives new candidates, it applies the same eligibility and allowlist rules
used at launch, merges them into the existing set, and publishes a new
`OutputRedactor` snapshot with a rebuilt Aho-Corasick matcher. Rebuild cost is
paid only on candidate changes, not on every output chunk.

The event is daemon-local. It must not be written to RuntimeStateDoc, sent to
other peers, stored in notebook metadata, or surfaced in user-visible logs. The
only observable effect is that later text output is redacted.

There is no producer-supplied generation in the event. The daemon owns any
generation counter used for observability or tests. Producers can dedupe by
tracking the last candidate set they reported; the daemon must still dedupe by
value because producer events are best-effort and may be repeated.

## Redactor Publication Model

`OutputRedactor` should remain an immutable redaction snapshot. Current output
paths hold `Arc<OutputRedactor>` clones in stream and display committers and pass
`&OutputRedactor` through manifest-building helpers, so runtime refresh should
not mutate the inner redactor behind those existing `Arc`s.

Instead, introduce a small daemon-owned redactor handle that can atomically
publish a replacement snapshot:

```rust
pub(crate) struct OutputRedactorHandle {
    current: ArcSwap<OutputRedactor>,
}
```

An equivalent atomic-snapshot primitive is fine if the project avoids adding a
dependency, but the key property is that output workers load the current
`Arc<OutputRedactor>` at commit boundaries and then use an immutable
`&OutputRedactor` for that redaction operation. Candidate refresh builds a new
snapshot off the hot path and swaps it into the handle. In-flight output may use
the previous snapshot; later output observes the refreshed one.

Avoid putting a `Mutex` or `RwLock` inside `OutputRedactor` itself. That would
make every output chunk take a synchronization guard on the redaction hot path.

## Event Bounds

Runtime candidate refresh is best-effort and must be bounded so a buggy producer
cannot force unbounded matcher rebuilds:

- cap each `AddRedactionCandidates` event to a small batch, such as 128 values;
- cap the total daemon candidate set per kernel, such as 4096 values;
- drop or truncate excess values with a count-only diagnostic, never with the
  values themselves;
- coalesce bursts before rebuilding the matcher, for example by draining pending
  candidate events for a short debounce window around 50 ms.

If the event remains fire-and-forget, truncation plus count-only diagnostics is
simpler than adding response plumbing. If a future implementation needs producer
feedback, add an explicit response channel rather than overloading the event
payload.

## Producer Detection

Python should be first because it has the strongest visibility:

- Keep the existing `os.environ` cache for the hot output path.
- Track the last candidate set reported by the launcher.
- When `eligible_env_values()` refreshes and sees new eligible values, call a
  narrow runtime-agent hook to report only the new values.
- Optionally patch common dotenv entry points later if passive cache refresh is
  not timely enough.

Deno or other kernels can adopt the same event when their launcher/runtime
adapter can observe environment mutations. Kernels that cannot observe runtime
secrets simply continue with launch-time daemon redaction.

## Daemon API

Extend `OutputRedactor` with a merge method:

```rust
pub(crate) fn add_values(&mut self, values: impl IntoIterator<Item = String>) -> bool
```

This method should operate on an owned snapshot during refresh, not on the
shared hot-path instance. It returns `true` only when at least one eligible, new
value was inserted and the matcher was rebuilt. The method must preserve:

- known non-secret key/value filtering where a key is available;
- value eligibility checks for length, boundary whitespace, and common values;
- deterministic longest-overlap replacement;
- binary MIME skipping at the output-value traversal layer.

For runtime-reported values without keys, use value eligibility only. Producers
should still avoid reporting known public values when they can identify them.

## Ordering

Refresh events only affect output processed after the daemon applies them. The
system does not retroactively rewrite existing RuntimeStateDoc manifests or blob
content. That keeps the design simple and avoids expensive blob rewrites. If a
producer learns a secret after it has already emitted it, the prior output is out
of scope for automatic repair.

## Testing

- Unit-test `OutputRedactor::add_values` for dedupe, matcher rebuild, longest
  overlap preservation, and no-op behavior for ineligible values.
- Unit-test the publication handle so a refreshed snapshot is visible to later
  output while an already-loaded snapshot remains usable.
- Unit-test event bounds: per-event truncation, total candidate cap, dedupe, and
  burst coalescing.
- Add a daemon-side test where an output before refresh leaks a synthetic value
  and output after refresh is redacted.
- Add Python launcher unit tests for candidate delta detection without logging
  or exposing the values.
- Keep existing launch-time and binary MIME redaction tests unchanged.

## Rollout

1. Land launch-time daemon matcher optimization.
2. Land producer candidate cache so Python can refresh cheaply.
3. Add `OutputRedactor::add_values` and daemon-local event plumbing behind tests.
4. Add Python delta reporting as the first producer.
5. Consider Deno/runtime-specific integrations after the protocol has one
   working producer.
