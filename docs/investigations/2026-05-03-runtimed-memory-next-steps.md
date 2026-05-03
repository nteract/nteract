# Runtimed Memory — Further Investigation Needed

> Companion to [2026-05-03-runtimed-memory.md](./2026-05-03-runtimed-memory.md)
> and [2026-05-03-runtimed-memory-proposals.md](./2026-05-03-runtimed-memory-proposals.md)

## Open Questions

### 1. What is the 545 MB actually storing?

We know it's anonymous private heap memory. We don't know what's in it.

**How to investigate:**

```bash
# Enable ptrace so heaptrack can attach
echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope

# Attach heaptrack to running daemon
heaptrack -p $(pgrep -f "runtimed$" | head -1)

# Let it run through a pool warming cycle, then Ctrl-C
# Analyze with:
heaptrack_print heaptrack.runtimed.*.zst | head -100
```

Alternatively, if using jemalloc (approach A3):

```rust
// Add to daemon, callable via IPC or signal
jemalloc_ctl::epoch::advance().unwrap();
let allocated = jemalloc_ctl::stats::allocated::read().unwrap();
let resident = jemalloc_ctl::stats::resident::read().unwrap();
let retained = jemalloc_ctl::stats::retained::read().unwrap();
info!("jemalloc: allocated={}, resident={}, retained={}", allocated, resident, retained);
```

This would immediately tell us: of the 578 MB RSS, how much is *allocated*
(live objects) vs *resident but freed* (allocator retention).

**Priority: HIGH** — this is the single most important unknown.

### 2. Memory timeline during pool warming

We don't know when the memory is allocated. Is it:
- (a) All at startup during initial pool warming? (likely)
- (b) Gradual growth over time? (memory leak)
- (c) Spike during warming, partial return after? (allocator retention)

**How to investigate:**

```bash
# Log RSS every second during startup
while true; do
  ps -p $(pgrep -f "runtimed$" | head -1) -o rss= 2>/dev/null
  sleep 1
done | ts '%H:%M:%S' > /tmp/rss_timeline.log
```

Or more precisely, add tracing to the daemon:

```rust
fn log_memory() {
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if line.starts_with("VmRSS:") {
                info!("[memory] {}", line.trim());
            }
        }
    }
}
```

Call this at key points: after daemon init, before/after each warming cycle,
after GC, etc.

**Priority: HIGH** — tells us whether this is a one-time cost or ongoing.

### 3. Rattler repodata cache size

When rattler resolves conda dependencies, it downloads repodata (JSON index
of all packages in a channel). conda-forge's repodata is **hundreds of MB**
uncompressed. If rattler holds this in memory (even temporarily), it could
explain a large chunk of the 545 MB.

**How to investigate:**

```bash
# Check if rattler caches to disk
find ~/.cache/rattler -type f -name "*.json" -exec ls -lh {} \; 2>/dev/null
du -sh ~/.cache/rattler/ 2>/dev/null

# Check conda-forge repodata size
find ~/.cache/rattler -name "repodata*" -exec ls -lh {} \; 2>/dev/null
```

Also check `rattler_repodata_gateway` — does it use mmap or load into heap?

**Priority: MEDIUM** — rattler is a prime suspect.

### 4. Automerge document size

The daemon uses Automerge for CRDT-based notebook sync. Automerge documents
retain full edit history. If a notebook has extensive history, the Automerge
document could be large.

**How to investigate:**

```bash
# Check persisted automerge docs
find ~/.cache/runt -name "*.automerge" -exec ls -lh {} \;
du -sh ~/.cache/runt/notebook-docs/ 2>/dev/null
```

Also: how many notebook rooms are active? Each room holds an Automerge doc
in memory.

**Priority: MEDIUM** — Automerge is known to be memory-hungry.

### 5. SQLite page cache

The daemon bundles rusqlite for the trusted packages store. SQLite's default
page cache is 2 MB, but if `PRAGMA cache_size` has been increased or if
there are many open connections, this could add up.

**How to investigate:**

```bash
# Check the database size
ls -lh ~/.cache/runt/trusted-packages.db 2>/dev/null
```

```rust
// In code, check cache size
conn.pragma_query_value(None, "cache_size", |row| row.get::<_, i64>(0))
```

**Priority: LOW** — unlikely to be a major contributor.

### 6. glibc arena count

glibc creates per-thread arenas (up to `8 * cores`). The two 63 MB regions
we saw match glibc's 64 MB arena size. On an 8-core machine, that's
potentially 64 arenas × 64 MB = 4 GB virtual (though most would be empty).

**How to investigate:**

```bash
# Check current arena count
MALLOC_ARENA_MAX=2 runtimed run &
# Wait for warming, then compare RSS

# Or use malloc_info() which dumps XML stats
# (requires small C helper or FFI call)
```

**Priority: HIGH** — `MALLOC_ARENA_MAX=2` is a zero-cost experiment.

### 7. Are there memory leaks?

The VmHWM (634 MB) vs VmRSS (578 MB) gap suggests memory IS being freed.
But is the 578 MB a stable plateau, or is it slowly growing?

**How to investigate:**

```bash
# Monitor over 24 hours
while true; do
  echo "$(date +%H:%M) $(grep VmRSS /proc/$(pgrep -f 'runtimed$' | head -1)/status)"
  sleep 300  # every 5 min
done >> /tmp/runtimed_rss_24h.log
```

**Priority: MEDIUM** — rules out leaks.

### 8. Impact of pool size configuration

The daemon is configured with pool sizes for UV, Conda, and Pixi. What are
the current settings, and does setting them to 0 change RSS?

**How to investigate:**

```bash
# Check current settings
runtimed status --json 2>/dev/null | python3 -m json.tool

# Try with all pools disabled
runtimed run --uv-pool-size 0 --conda-pool-size 0 --pixi-pool-size 0
# Measure RSS after startup stabilizes
```

**Priority: HIGH** — if disabling pools drops RSS to ~50 MB, we know warming
is the cause.

### 9. Binary stripping

The binary is not stripped (41k symbols, ~4.6 MB of symbol tables). While
symbol tables aren't loaded into RSS, stripping might slightly reduce mmap'd
regions.

```bash
strip -s /home/ubuntu/.local/share/runt/bin/runtimed
# Measure before/after
```

**Priority: LOW** — cosmetic, ~0 RSS impact.

## Suggested Investigation Order

For the next session, this is the highest-signal sequence:

1. **Try `MALLOC_ARENA_MAX=2`** (5 min, high signal)
2. **Try `--uv-pool-size 0 --conda-pool-size 0 --pixi-pool-size 0`** (5 min, high signal)
3. **Add RSS logging at key points in daemon lifecycle** (30 min)
4. **Attach heaptrack** (requires ptrace_scope=0, 10 min)
5. **Check rattler repodata cache** (5 min)
6. **Try mimalloc** (30 min)

Steps 1 and 2 alone will tell you whether this is an allocator problem or a
pool-warming problem, which determines whether Strategy A or Strategy B from
the proposals doc is the right path.
