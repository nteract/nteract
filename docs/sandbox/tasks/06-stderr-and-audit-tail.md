# Task 06: stderr parsing and audit log tail

## Framing

Convert the raw stdout/stderr streams from the supervisor (task 04) and the audit log NDJSON file into a typed event stream that downstream consumers (task 08) can pattern-match against. This is the signal-extraction layer: it does not interpret events into user-facing messages, only normalizes them.

Depends on task 04. Blocks task 08.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-12 (audit log discovery)**, **D-13 (always -vv)**
- `docs/sandbox/nono-empirical-tests.md` — the OQ-7 (audit schema), OQ-8 (session ID location), OQ-6 (stderr message shapes) sections
- `docs/sandbox/nono-error-signals.md` — full enumeration of what nono emits
- `docs/sandbox/error-routing-design.md` — section "What the daemon actually watches" (the three signal sources)

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

Three signal sources, in priority order:

1. **stderr (verbose)**: `ALLOW`/`DENY` lines from `tracing` output. Format is approximately:
   ```
   ALLOW REVERSE analytics_api GET /v1/data -> 401
   DENY  CONNECT new-api.example.com reason=host_not_allowed
   ```
   These are not a stable API. Parse defensively, fail open (skip enrichment if a line cannot be parsed), and record the nono version in the parser so future format changes are explicit.

2. **stdout (verbose)**: at `-vv`, a DEBUG line carries the session ID (a hex string). The exact format must be confirmed empirically.

3. **Audit log NDJSON**: at `~/.nono/audit/<timestamp>-<pid>/audit-events.ndjson`. Each line:
   ```json
   {"sequence": 0, "prev_chain": "...", "leaf_hash": "...", "chain_hash": "...", "event_json": "...", "event": {"type": "session_started", ...}}
   ```
   Default verbosity emits only `session_started` and `session_ended`. With `-vv`, network events appear (per-request entries). The file is append-only and may be flushed at session end rather than per-request — design the tailer to handle both real-time and end-of-session arrival.

The audit directory is named `<timestamp>-<pid>`. The daemon knows the spawn time and the nono PID (from task 04), so it can locate the directory via filesystem scan after a brief settle period.

## Technical steps

### 1. Module skeleton

Add `crates/runtimed/src/nono/events.rs` (re-export from `crates/runtimed/src/nono/mod.rs`).

```rust
#[derive(Debug, Clone)]
pub enum NonoEvent {
    /// Session started — first event from the audit log; carries the session ID
    SessionStarted { session_id: String, at: SystemTime },
    /// Session ended — last event from the audit log
    SessionEnded { at: SystemTime },
    /// Per-request ALLOW from stderr
    RequestAllowed {
        kind: RequestKind,           // CONNECT or REVERSE
        credential: Option<String>,  // populated for REVERSE
        host: Option<String>,        // populated for CONNECT
        method: Option<String>,
        path: Option<String>,
        status: Option<u16>,
        at: Instant,
        raw: String,
    },
    /// Per-request DENY from stderr
    RequestDenied {
        kind: RequestKind,
        host: Option<String>,
        reason: String,              // e.g. "host_not_allowed", "credential_missing"
        at: Instant,
        raw: String,
    },
    /// A line we received but did not recognize (kept for diagnostics)
    Unparsed { source: Source, line: String, at: Instant },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind { Connect, Reverse }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source { Stdout, Stderr, Audit }

pub struct EventStream {
    pub events: mpsc::Receiver<NonoEvent>,
    pub session_id: tokio::sync::watch::Receiver<Option<String>>,
}

pub struct EventCollector {
    // private
}

impl EventCollector {
    /// Spawns the parser tasks. Owns the supervisor's receivers.
    pub fn start(
        nono_pid: u32,
        spawn_time: SystemTime,
        stdout: mpsc::Receiver<StdoutLine>,
        stderr: mpsc::Receiver<StderrLine>,
    ) -> EventStream;
}
```

### 2. stderr parser

Implement a line parser for the ALLOW/DENY format. Use a single regex per shape, or a small hand-rolled tokenizer. **Always** fail open: any line that does not match emits `NonoEvent::Unparsed`, never an error.

The regex should be liberal about whitespace and trailing fields. Verify against the actual `nono -vv` output during tests.

### 3. stdout parser

Look for the session ID DEBUG line. Format should be confirmed empirically. The session ID comes through a `tokio::sync::watch::Sender<Option<String>>` so consumers can `.await` it. After the session ID is set, stop scanning stdout (it is otherwise low-signal).

### 4. Audit log discovery

After a settle period (recommend 250ms after spawn), scan `~/.nono/audit/`:

- Filter for entries whose name matches `<digits>-<pid_string>` and whose `<pid_string>` equals the nono PID
- If multiple match, pick the one whose mtime is closest to the spawn time
- Retry every 250ms for up to 5 seconds before logging a warning and giving up

Once located, the audit path is `<dir>/audit-events.ndjson`.

If the audit directory is never found, the audit-stream subsystem stays inactive but the stderr/stdout parser continues to operate. Log a warning, do not error.

### 5. Audit log tailer

Two operating modes the tailer must handle:

- **Real-time append**: the file grows during the session. Tail with periodic polling (recommend 100ms interval) or `notify` crate for FSEvents on macOS / inotify on Linux. Polling is simpler and adequate for MVP — pick polling unless `notify` is already a workspace dependency.
- **End-of-session flush**: the file may be empty until the session ends, then written all at once. The tailer must not deadlock waiting for early lines.

Parse each line as JSON. Emit `SessionStarted`/`SessionEnded` accordingly; map other event types defensively (unknown type → `Unparsed`).

If the audit file is signed/HMAC'd (it has Merkle hash chain fields), do **not** verify integrity in MVP — see decision **D-19** (deferred).

### 6. Channel backpressure

The output `mpsc::Receiver<NonoEvent>` is bounded (~2048). On overflow, drop oldest events and log a counter once per second. The collector must never block on a slow consumer.

### 7. Tests

- Parse a fixture stderr stream containing real ALLOW/DENY lines (capture from a manual `nono -vv` run; commit fixtures to a `crates/runtimed/test_fixtures/nono/` directory)
- Parse the stdout session-ID line
- Audit log discovery: create a fake directory tree, confirm correct selection
- NDJSON parser: feed lines, confirm events emitted
- Unparsed line is preserved with original text
- Backpressure: slow consumer does not block parser
- Session ID is set before any RequestAllowed events are emitted (this ordering matters for correlation in task 08)

## Interfaces produced

- `runtimed::nono::events::NonoEvent` enum
- `EventCollector::start(...)` and `EventStream { events, session_id }`
- Test fixtures of real stderr/stdout/audit output for downstream tests

Consumed by task 08.

## Success criteria

- Real `nono -vv` output is parsed correctly across the four scenarios in `error-routing-design.md`
- Unparsed lines never crash the parser
- Audit log discovery works for the empirical naming convention
- `cargo xtask lint --fix` passes
- Tests pass on macOS (and Linux if implementer has access)

## In scope

- The `NonoEvent` enum and `EventCollector`
- stderr/stdout/audit parsers
- Audit directory discovery
- Backpressure handling
- Test fixtures from real nono output
- Defensive failure modes

## Out of scope

- Mapping `NonoEvent` to user-facing messages or `CellAnnotation` — task 08
- Correlating events with executions — task 08
- Audit log Merkle integrity verification (deferred)
- Detecting credential _absence_ at startup beyond what nono prints to stderr — that is naturally captured here as `Unparsed` initially, then matched by task 08
- Dynamic credential rotation — out of MVP entirely
- Anything UI or MCP-facing — tasks 09–11
