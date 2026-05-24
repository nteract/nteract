# Runtime Redaction Candidate Refresh Design

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
    generation: u64,
    values: Vec<String>,
}
```

The daemon owns the canonical `OutputRedactor` for the kernel. When it receives
new candidates, it applies the same eligibility and allowlist rules used at
launch, merges them into the existing set, increments the redactor generation,
and rebuilds the Aho-Corasick matcher. Rebuild cost is paid only on candidate
changes, not on every output chunk.

The event is daemon-local. It must not be written to RuntimeStateDoc, sent to
other peers, stored in notebook metadata, or surfaced in user-visible logs. The
only observable effect is that later text output is redacted.

## Producer Detection

Python should be first because it has the strongest visibility:

- Keep the existing `os.environ` cache for the hot output path.
- Track the last candidate set and generation in the launcher.
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

It should return `true` only when at least one eligible, new value was inserted
and the matcher was rebuilt. The method must preserve:

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
