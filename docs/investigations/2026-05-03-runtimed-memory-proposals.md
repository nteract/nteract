# Runtimed Memory — Proposed Approaches

> Companion to [2026-05-03-runtimed-memory.md](./2026-05-03-runtimed-memory.md)

## The Two Strategies

There are two fundamentally different approaches to reducing runtimed's
~578 MB footprint. They're not mutually exclusive and can be pursued in
parallel.

### Strategy A: Fix the Allocator Behavior

**Thesis:** A significant portion of the 545 MB anonymous heap is freed memory
that glibc's malloc is holding onto. Tuning or replacing the allocator will
return it to the OS.

**Why this might work:**
- VmHWM (634 MB) > VmRSS (578 MB) — memory *has* been freed
- glibc malloc is notoriously bad at returning memory in multi-threaded
  programs (tokio = many threads)
- The two ~63 MB anonymous regions match glibc's per-thread arena size
- This is a known problem class with known solutions

**What to try (ordered by effort):**

#### A1. Tune glibc malloc via environment variables (5 min)

```bash
# Limit arena count (default: 8 * cores = 64 on this machine)
MALLOC_ARENA_MAX=2 runtimed run

# Lower mmap threshold so large allocations use mmap (returnable to OS)
MALLOC_MMAP_THRESHOLD_=65536 runtimed run

# Enable trimming
MALLOC_TRIM_THRESHOLD_=131072 runtimed run
```

Test by setting these in the systemd service or launchd plist and measuring
RSS after the same workload.

**Expected impact:** Could reduce RSS by 100–200 MB if the problem is arena
bloat. Zero code changes.

#### A2. Periodic `malloc_trim(0)` calls (30 min)

Add a timer in the daemon's main loop that calls `libc::malloc_trim(0)` every
60 seconds (or after pool warming completes). This asks glibc to return free
memory to the OS.

```rust
// In daemon.rs, inside the main run loop or as a spawned task
#[cfg(target_os = "linux")]
{
    extern "C" { fn malloc_trim(pad: usize) -> i32; }
    unsafe { malloc_trim(0); }
}
```

**Expected impact:** Should return freed-but-retained memory. If VmHWM - VmRSS
gap grows, this is working.

#### A3. Switch to a different allocator (1 hour)

```toml
# Cargo.toml
[dependencies]
mimalloc = { version = "0.1", default-features = false }
# OR
tikv-jemallocator = "0.6"
```

```rust
// main.rs
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
```

**mimalloc** pros:
- Better memory return behavior than glibc
- Lower fragmentation
- Good multi-threaded performance
- Microsoft-maintained

**jemalloc** pros:
- Battle-tested with tokio workloads
- Supports `malloc_stats_print()` for introspection
- `prof:true` for heap profiling without external tools

**Expected impact:** Hard to predict without measuring. Could be dramatic
(50%+ reduction) or modest (10–20%) depending on whether the problem is
allocator behavior vs. genuinely live data.

---

### Strategy B: Subprocess Isolation for Heavy Operations

**Thesis:** Pool warming (especially rattler/conda operations) creates large
temporary allocations that bloat the daemon's RSS permanently. Moving these
to short-lived subprocesses means the memory is returned when the subprocess
exits.

**Why this might work:**
- Pool warming is periodic and self-contained
- Rattler's dependency resolution is known to be memory-hungry
- Repodata downloads can be tens of MB
- A subprocess that exits returns ALL its memory to the OS — no fragmentation
- This is the pattern already used for runtime-agent

**What to try:**

#### B1. Pool warming as subprocess (medium effort, ~1 day)

Create a new subcommand:

```
runtimed warm-env --type uv --packages numpy,pandas --output /path/to/env
```

The main daemon spawns this as a subprocess, waits for completion, then
registers the resulting environment in its pool. The subprocess exits and all
its memory (rattler solver, repodata, HTTP buffers) vanishes.

**Architecture:**

```
runtimed (main daemon, lean)
  ├── Accepts IPC connections
  ├── Manages pool metadata
  ├── Spawns warming subprocesses
  │     └── runtimed warm-env (dies after creating env)
  └── Spawns runtime-agent subprocesses
        └── runtimed runtime-agent (per-notebook)
```

**Expected impact:** If pool warming is the primary source of large
allocations, this could reduce the daemon to ~50–100 MB. The subprocess
would briefly use whatever rattler needs, then exit cleanly.

**Risks:**
- More complex IPC (need to communicate env path, errors, progress)
- Slightly slower warming (process startup overhead)
- Need to handle subprocess crashes gracefully

#### B2. Lazy-load rattler (medium effort, ~1 day)

Instead of linking rattler statically, use `dlopen` or a subprocess to load
rattler only when needed. This avoids both the code size (1.5 MB .text) and
any static initialization costs.

More realistically: gate the conda/pixi warming behind a feature flag so
builds that don't need it don't pay for it. The warming subprocess (B1) would
be the only binary that links rattler.

#### B3. Split into separate binaries (larger effort, ~2-3 days)

Instead of one binary with subcommands, create:

```
runtimed           ← lean daemon (pool management, IPC, sync)
runtimed-agent     ← per-notebook runtime (jupyter, alacritty, streams)
runtimed-warm      ← pool warming (rattler, conda, HTTP)
```

Each binary only links what it needs. The daemon binary would drop:
- alacritty_terminal (only needed by agent)
- jupyter_protocol (only needed by agent)
- rattler_* (only needed by warmer)
- rattler_repodata_gateway (only needed by warmer)

**Expected impact on binary size:** Daemon could shrink from 35 MB to ~15 MB.
**Expected impact on RSS:** Hard to say — depends on whether static init of
these crates contributes to memory.

---

## Recommendation: Run A1 + A2 + B1 In Parallel

| Approach | Effort | Confidence | Reversible |
|----------|--------|------------|------------|
| A1: glibc env vars | 5 min | Medium | Yes (just env vars) |
| A2: malloc_trim | 30 min | Medium | Yes (feature-flagged) |
| A3: Switch allocator | 1 hour | Medium | Yes (one line change) |
| B1: Subprocess warming | 1 day | High | Requires design |
| B2: Lazy-load rattler | 1 day | Low-Medium | Medium |
| B3: Split binaries | 2-3 days | Medium | Major refactor |

**Phase 1 (immediate, today):**
- Try A1 (glibc env vars) on the running daemon — zero risk, instant signal
- Try A2 (malloc_trim) — tiny code change, tells us how much is freed-but-retained

**Phase 2 (this week):**
- Try A3 (mimalloc or jemalloc) — one-line change, measure impact
- Design B1 (subprocess warming) — this is the architecturally correct solution
  regardless of allocator behavior

**Phase 3 (if needed):**
- Implement B1
- Consider B3 if binary size matters (e.g., for distribution)

The key insight: **A1/A2 will tell us whether the problem is allocator
retention or genuinely live data.** If `malloc_trim` drops RSS by 200+ MB,
the problem is retention and A3 is the fix. If RSS barely moves, the data
is live and B1 is the fix.
