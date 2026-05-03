# Runtimed Memory Investigation — 2026-05-03

## Summary

The `runtimed` main daemon process (PID 3189) uses **~578 MB RSS** at steady
state on an idle system with one notebook session open. This is surprisingly
high for a Rust daemon whose binary is only 35 MB on disk.

**Root cause:** ~545 MB of anonymous heap allocations. These are real, private,
resident pages — not shared memory, not file-backed mappings, not allocator
bookkeeping artifacts. Something (or several things) in the daemon's startup
and pool-warming lifecycle is allocating and retaining large amounts of memory.

## What We Know For Certain

### Binary & Process Facts

| Metric | Value |
|--------|-------|
| Binary on disk | 35 MB (not stripped, release build) |
| `.text` section (code) | 10.1 MB |
| VmRSS (current) | 578 MB |
| VmHWM (peak) | 634 MB |
| VmData (heap+data) | 694 MB |
| VmExe (code in RAM) | 10 MB |
| VmLib (shared libs) | 6 MB |
| Allocator | **System (glibc malloc)** — no `#[global_allocator]` override |
| Child process (runtime-agent) | 20 MB RSS |

### Memory Map Breakdown

From `/proc/3189/smaps`:

| Category | RSS | PSS | Notes |
|----------|-----|-----|-------|
| Anonymous heap (`[anon]` + `[heap]`) | **545 MB** | **545 MB** | PSS ≈ RSS → private, not shared |
| Binary (runtimed) | 13 MB | 8 MB | Code + rodata; PSS < RSS because shared w/ child |
| Shared libraries | 7 MB | 4 MB | libcrypto, libssl, libc, libm, etc. |
| **Total** | **565 MB** | **557 MB** | |

**Key insight:** PSS ≈ RSS for anonymous regions means this is genuinely
allocated, private memory — not CoW pages shared with the child process, not
mmap'd files, not allocator overhead that "looks big but isn't real."

### Largest Anonymous Regions

Two regions dominate at ~63 MB each, followed by a long tail of 5–30 MB
regions:

```
62.7 MB  [anon]  ← glibc malloc arena
62.6 MB  [anon]  ← glibc malloc arena
30.1 MB  [anon]
27.9 MB  [anon]
27.4 MB  [anon]
24.5 MB  [anon]
22.5 MB  [anon]
21.0 MB  [anon]
...      (long tail of 5–10 MB regions)
10.8 MB  [heap]  ← main heap (brk-based)
```

The 63 MB regions are characteristic of **glibc's per-thread arena allocation**
(`MALLOC_ARENA_MAX` defaults to `8 * num_cores`). On this 8-core machine,
glibc can create up to 64 arenas, each starting at 64 MB. Tokio's thread pool
triggers this.

### VmHWM vs VmRSS

Peak was **634 MB**, current is **578 MB**. The daemon has freed ~56 MB since
its peak, but glibc hasn't returned it to the OS. This is expected behavior —
glibc's `malloc` is conservative about calling `madvise(MADV_DONTNEED)` or
`munmap` for freed memory.

### Architecture

Single binary (`runtimed`) serves two roles via subcommand:

```
runtimed              ← main daemon (PID 3189, 578 MB)
runtimed runtime-agent ← per-notebook subprocess (PID 3945, 20 MB)
```

The daemon spawns runtime-agent as a child process via `tokio::process::Command`
(fork+exec), so they do NOT share heap memory.

### Dependency Weight (code size via cargo-bloat)

Top contributors to `.text` section:

| Crate | Code Size | Used By |
|-------|-----------|---------|
| runtimed (own code) | ~3.5 MB | Everything |
| rattler_* (conda solver) | ~1.5 MB | Pool warming only |
| automerge | ~0.8 MB | Notebook sync |
| jupyter_protocol | ~0.5 MB | Runtime agent only* |
| reqwest/h2 | ~0.4 MB | HTTP client |
| regex_automata | ~0.3 MB | Error parsing |
| alacritty_terminal | ~0.2 MB | Runtime agent only* |
| sqlite3 (bundled) | ~0.2 MB | Trust store |

*These are compiled into the daemon binary but only called on the
`runtime-agent` code path.

### What the Daemon Does at Startup

From `daemon.rs` and `main.rs`:

1. Parse CLI args, set up logging
2. Create `Daemon` struct with config
3. Acquire singleton lock
4. Start blob HTTP server (hyper)
5. Start 3 pool warming loops (UV, Conda, Pixi)
6. Start notebook sync server
7. Start settings file watcher (notify)
8. Start GC loop for stale environments
9. Accept IPC connections on Unix socket

Each warming loop:
- Bootstraps tool (uv/conda/pixi) via rattler if needed
- Creates virtual environments with pre-installed packages
- Runs warmup scripts
- Maintains pool metadata

## What We Don't Know (Yet)

1. **Where exactly the 545 MB of heap is going.** We know it's anonymous
   private memory, but we haven't profiled which allocation sites are
   responsible. Candidates:
   - Rattler's dependency resolver (likely creates large temporary structures)
   - Automerge document state
   - Repodata caches (conda channel metadata can be huge)
   - SQLite page cache (bundled rusqlite)
   - Tokio runtime buffers
   - Connection state for notebook sync

2. **How much is live data vs. freed-but-retained.** glibc malloc doesn't
   eagerly return memory. Some of that 545 MB may be freed by the application
   but held by the allocator. We need `malloc_stats()` or heaptrack to
   distinguish.

3. **The allocation timeline.** Does the memory spike during pool warming and
   then plateau? Or does it grow steadily? VmHWM (634 MB) > VmRSS (578 MB)
   suggests some memory was freed, but we don't know when or by what.

4. **Whether the runtime-agent inherits significant memory.** It's 20 MB
   after exec, which is reasonable, but we should verify it's not inheriting
   state it doesn't need.

5. **What `MALLOC_ARENA_MAX` and `MALLOC_MMAP_THRESHOLD_` would do.** These
   glibc tunables can dramatically reduce memory for multi-threaded programs.

## Correction From Earlier Analysis

Previous agents in this conversation incorrectly stated:
- That PSS was 0.0 for anonymous regions (parsing bug — PSS ≈ RSS)
- That jemalloc was the allocator (it's glibc malloc — no custom allocator)
- That the memory was "allocator fragmentation" (it may be, but we can't
  distinguish from live allocations without profiling)

The corrected picture: **545 MB of real, private, anonymous heap memory** that
is either (a) genuinely live data structures, (b) freed memory retained by
glibc's allocator, or (c) some mix. We need profiling to determine which.
