import { ObservableStore, select } from "runtimed";
import { Subject } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

interface CounterState {
  count: number;
  label: string;
}

const ZERO: CounterState = { count: 0, label: "zero" };

/** Test-only subclass exposing named public mutators over the protected setters. */
class CounterStore extends ObservableStore<CounterState> {
  constructor() {
    super(ZERO);
  }
  put(next: CounterState): void {
    this.setState(next);
  }
  bump(): void {
    this.updateState((cur) => ({ ...cur, count: cur.count + 1 }));
  }
  clear(): void {
    this.resetState(ZERO);
  }
}

function collect<T>(observable: { subscribe: (next: (value: T) => void) => unknown }): T[] {
  const values: T[] = [];
  observable.subscribe((value) => values.push(value));
  return values;
}

describe("ObservableStore", () => {
  it("starts unloaded with the initial snapshot", () => {
    const store = new CounterStore();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot).toBe(ZERO);
  });

  it("setState marks loaded and emits; resetState returns to default", () => {
    const store = new CounterStore();
    const loaded = collect(store.loaded$);
    store.put({ count: 1, label: "one" });
    expect(store.isLoaded).toBe(true);
    expect(store.snapshot).toEqual({ count: 1, label: "one" });
    store.clear();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot).toBe(ZERO);
    expect(loaded).toEqual([false, true, false]);
  });

  it("updateState derives the next state from the current snapshot", () => {
    const store = new CounterStore();
    store.bump();
    store.bump();
    expect(store.snapshot).toEqual({ count: 2, label: "zero" });
  });

  it("select dedups with the provided equality", () => {
    const store = new CounterStore();
    const seen = collect(store.select((s) => s.count));
    store.put({ count: 1, label: "one" });
    // Same count, new label — projected slice unchanged, must not re-emit.
    store.put({ count: 1, label: "uno" });
    store.put({ count: 2, label: "two" });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("select honors a named field-by-field comparator on an allocating projector", () => {
    const store = new CounterStore();
    const seen = collect(store.select((s) => ({ count: s.count }), counterSliceEquals));
    store.put({ count: 1, label: "one" });
    // Fresh object each tick, same count — comparator holds the prior value.
    store.put({ count: 1, label: "uno" });
    expect(seen).toEqual([{ count: 0 }, { count: 1 }]);
  });
});

describe("select (free helper)", () => {
  it("projects and dedups off an arbitrary source observable", () => {
    const source$ = new Subject<CounterState>();
    const seen = collect(select(source$, (s) => s.count));
    source$.next({ count: 1, label: "one" });
    source$.next({ count: 1, label: "uno" });
    source$.next({ count: 2, label: "two" });
    expect(seen).toEqual([1, 2]);
  });
});

// Equality-convention completeness tripwire (Q5 / gap-flag G1). Demonstrates
// the named-comparator pattern the convention doc prescribes and pins its one
// hard guarantee: a manifest that omits a projection key fails to typecheck.
interface CounterSlice {
  count: number;
}

function counterSliceEquals(a: CounterSlice, b: CounterSlice): boolean {
  return a === b || a.count === b.count;
}

const _COUNTER_SLICE_FIELDS = { count: true } satisfies Record<keyof CounterSlice, true>;
void _COUNTER_SLICE_FIELDS;

// @ts-expect-error - manifest omits `count`, so it does not satisfy the
// completeness constraint: adding a field without listing it breaks the build.
const _INCOMPLETE_SLICE_FIELDS = {} satisfies Record<keyof CounterSlice, true>;
void _INCOMPLETE_SLICE_FIELDS;

describe("named-comparator convention", () => {
  it("short-circuits on identity and compares each field", () => {
    const slice: CounterSlice = { count: 3 };
    expect(counterSliceEquals(slice, slice)).toBe(true);
    expect(counterSliceEquals({ count: 3 }, { count: 3 })).toBe(true);
    expect(counterSliceEquals({ count: 3 }, { count: 4 })).toBe(false);
  });
});
