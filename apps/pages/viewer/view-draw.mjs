// One view embed's drawing: the interpreter for view-draw-machine.mjs. It
// turns the view's projection (view-store.mjs) and the Page's sources
// (page-source-store.mjs) into plans, loads each plan's tables through the
// source store's resolver, and hands them to `render`. No DOM here: the
// chart chunk (view-chart.mjs) supplies `render` and `decode`.
//
// A plan is redrawn when the view's projection changes (a rewritten view
// always has a new revision) or a version one of its data names follows
// changes. A pinned binding (`{ source_id, revision }`) reads the source's
// history state for that revision and ignores later revisions; it still
// redraws when the source is removed.
import { map, of, switchMap } from "rxjs";
import { SourceUnavailable } from "./page-source-store.mjs";
import { versionKey } from "./source-follow.mjs";
import { viewDrawMachine } from "./view-draw-machine.mjs";

/** What an embed says while its view or its tables load, when they fail
 * to, and when the chart itself can't be drawn. */
export const VIEW_STATUS = Object.freeze({
  waiting: "Loading chart…",
  failed: "This chart's data couldn't be loaded.",
  broken: "This chart couldn't be drawn.",
});

const quoted = (ids) =>
  ids.length === 1
    ? `"${ids[0]}"`
    : `${ids
        .slice(0, -1)
        .map((id) => `"${id}"`)
        .join(", ")} and "${ids.at(-1)}"`;

/**
 * The one sentence a drawn chart carries when some of its data couldn't be
 * read, or null. `problems` lists `{ source_id, reason, revision? }`: a
 * source the Page doesn't hold (`missing`) or a pinned revision its history
 * doesn't hold (`revision`). Removed sources come first.
 */
export function viewNote(problems) {
  const gone = [
    ...new Set(problems.filter((p) => p.reason !== "revision").map((p) => p.source_id)),
  ];
  if (gone.length)
    return gone.length === 1
      ? `This chart's source ${quoted(gone)} isn't on this Page.`
      : `This chart's sources ${quoted(gone)} aren't on this Page.`;
  const pinned = problems.find((p) => p.reason === "revision");
  return pinned
    ? `This chart's source "${pinned.source_id}" has no revision ${pinned.revision} on this Page.`
    : null;
}

/**
 * The plan for drawing `view` (a ready projection's view) over the data
 * names the spec reads (`names`), resolved against `sources` now. `serial`
 * numbers the projection, so a rewritten view always makes a new key. Each
 * entry is `{ name, version }`, `version` null for data the Page can't
 * supply; that data draws as no rows.
 */
export function viewPlan(view, names, sources, serial) {
  const entries = [];
  const problems = [];
  for (const name of names) {
    const binding = view.data[name];
    let version = null;
    try {
      version = sources.resolve(binding);
    } catch (error) {
      if (!(error instanceof SourceUnavailable)) throw error;
      problems.push({
        source_id: binding.source_id,
        reason: error.reason,
        ...(binding.revision && { revision: binding.revision }),
      });
    }
    entries.push({ name, version });
  }
  const key = [
    `${view.view_id}#${serial}@${view.revision}`,
    ...entries.map(({ name, version }) => `${name}=${version ? versionKey(version) : "none"}`),
  ].join("|");
  return { key, view, entries, note: viewNote(problems) };
}

/**
 * Draw the view `view$` projects. Options:
 * - `sources`: the Page's source store.
 * - `decode(bytes, limits)`: the chart's decoder for a source's bytes; what it
 *   resolves with is the dataset the chart reads.
 * - `checkChartSpec(spec, { datasets })`: shared/chart-spec.mjs. It runs
 *   before every plan, so a refused spec loads nothing.
 * - `render.draw({ view, datasets, note })` mounts a chart and returns
 *   `{ destroy }`; `render.show({ state, sentence, note, title })` shows the
 *   embed's state after each step.
 * Returns `{ destroy, state }`.
 */
const BROKEN = Object.freeze({ type: "blocked", sentence: VIEW_STATUS.broken });

export function createViewDraw({ view$, sources, decode, checkChartSpec, render }) {
  let model = viewDrawMachine.initial;
  let latest = null;
  let chart = null;
  let serial = 0;
  let title = null;
  const loads = new Map();

  const show = () => {
    const shown = model.name === "drawn" || model.name === "loading" ? (chart?.plan ?? null) : null;
    render.show({
      state: model.name,
      sentence:
        model.name === "blocked"
          ? model.sentence
          : model.name === "failed"
            ? model.cause === "draw"
              ? VIEW_STATUS.broken
              : VIEW_STATUS.failed
            : model.name === "waiting" || (model.name === "loading" && !chart)
              ? VIEW_STATUS.waiting
              : null,
      note: shown?.note ?? null,
      title,
    });
  };

  // Events an effect raises (a chart that threw while mounting) wait until
  // the current step's effects have run.
  const raised = [];
  let stepping = false;
  const step = (event) => {
    raised.push(event);
    if (stepping) return;
    stepping = true;
    try {
      while (raised.length) {
        const result = viewDrawMachine.step(model, raised.shift());
        if (result.rejected) continue;
        model = result.state;
        for (const effect of result.effects) run(effect);
        show();
      }
    } finally {
      stepping = false;
    }
  };

  const free = (datasets) => {
    for (const table of Object.values(datasets ?? {})) table?.dispose?.();
  };

  /** Tear the drawn chart down. The embed lets go of it first, so a
   * destructor that throws leaves nothing referenced and stops nothing
   * after it. */
  const tearDown = () => {
    const previous = chart;
    chart = null;
    try {
      previous?.instance.destroy();
    } catch {}
  };

  function run(effect) {
    switch (effect.type) {
      case "load":
        return start(effect.generation, latest);
      case "cancel": {
        const load = loads.get(effect.generation);
        loads.delete(effect.generation);
        load?.controller.abort();
        free(load?.owned);
        return;
      }
      case "release": {
        const load = loads.get(effect.generation);
        loads.delete(effect.generation);
        free(load?.owned);
        return;
      }
      case "draw": {
        const load = loads.get(effect.generation);
        loads.delete(effect.generation);
        try {
          tearDown();
          const instance = render.draw({
            view: load.plan.view,
            datasets: load.datasets,
            note: load.plan.note,
          });
          chart = { instance, plan: load.plan };
        } catch {
          step({ type: "drawFailed", generation: effect.generation });
        } finally {
          // The chart copied what it reads when it mounted; a chart that
          // threw keeps nothing.
          free(load.owned);
        }
        return;
      }
      case "clear":
        return tearDown();
    }
    throw new Error(`unknown effect ${effect.type}`);
  }

  /** Load `plan`'s tables as load `generation`: each source version once,
   * however many data names read it. */
  function start(generation, plan) {
    const controller = new AbortController();
    // `owned` holds each decoded table once, by version, to free;
    // `datasets` names them by data name, to draw.
    const load = { controller, plan, owned: null, datasets: null };
    loads.set(generation, load);
    let resolver;
    try {
      resolver = sources.resolver(decode);
    } catch {
      // The Page's sources closed: this load can't run.
      queueMicrotask(() => step({ type: "loadFailed", generation }));
      return;
    }
    const byVersion = new Map();
    for (const { version } of plan.entries) {
      if (!version) continue;
      const id = versionKey(version);
      if (!byVersion.has(id))
        byVersion.set(
          id,
          resolver.load(version, { signal: controller.signal }).then((loaded) => loaded.table),
        );
    }
    const ids = [...byVersion.keys()];
    Promise.allSettled(byVersion.values()).then((results) => {
      const owned = Object.fromEntries(
        results.flatMap((result, index) =>
          result.status === "fulfilled" ? [[ids[index], result.value]] : [],
        ),
      );
      if (controller.signal.aborted || loads.get(generation) !== load) return free(owned);
      if (results.some((result) => result.status === "rejected")) {
        // The failed load's record goes with the machine's release.
        load.owned = owned;
        return step({ type: "loadFailed", generation });
      }
      load.owned = owned;
      load.datasets = Object.fromEntries(
        plan.entries.map(({ name, version }) => [name, version ? owned[versionKey(version)] : []]),
      );
      step({ type: "loaded", generation });
    });
  }

  const subscription = view$
    .pipe(
      switchMap((projection) => {
        if (projection.status === "pending") return of({ type: "pending" });
        if (projection.status === "unavailable") {
          title = null;
          return of({ type: "blocked", sentence: projection.sentence });
        }
        const { view } = projection;
        const number = ++serial;
        title = view.title;
        // A check or a plan that throws blocks this view with one sentence;
        // the stream lives on, so the view's next revision draws.
        let checked;
        try {
          checked = checkChartSpec(view.spec, { datasets: Object.keys(view.data) });
        } catch {
          return of(BROKEN);
        }
        if (!checked.ok) return of({ type: "blocked", sentence: checked.error });
        const ids = [...new Set(checked.names.map((name) => view.data[name].source_id))];
        return sources.versions(ids).pipe(
          map(() => {
            try {
              latest = viewPlan(view, checked.names, sources, number);
            } catch {
              return BROKEN;
            }
            return { type: "plan", key: latest.key };
          }),
        );
      }),
    )
    .subscribe(step);
  show();

  return {
    get state() {
      return model;
    },
    /** Loads this embed still holds a record of: running, or loaded and not
     * yet drawn. */
    get loads() {
      return loads.size;
    },
    destroy() {
      try {
        subscription.unsubscribe();
      } finally {
        step({ type: "destroy" });
      }
    },
  };
}
