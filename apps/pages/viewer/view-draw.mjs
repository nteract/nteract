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

/** What an embed says while its view or its tables load, and when they
 * fail to. */
export const VIEW_STATUS = Object.freeze({
  waiting: "Loading chart…",
  failed: "This chart's data couldn't be loaded.",
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
            ? VIEW_STATUS.failed
            : model.name === "waiting" || (model.name === "loading" && !chart)
              ? VIEW_STATUS.waiting
              : null,
      note: shown?.note ?? null,
      title,
    });
  };

  const step = (event) => {
    const result = viewDrawMachine.step(model, event);
    if (result.rejected) return result;
    model = result.state;
    for (const effect of result.effects) run(effect);
    show();
    return result;
  };

  const free = (datasets) => {
    for (const table of Object.values(datasets ?? {})) table?.dispose?.();
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
      case "draw": {
        const load = loads.get(effect.generation);
        loads.delete(effect.generation);
        chart?.instance.destroy();
        const instance = render.draw({
          view: load.plan.view,
          datasets: load.datasets,
          note: load.plan.note,
        });
        chart = { instance, plan: load.plan };
        // The chart turned the tables into its own rows when it mounted.
        free(load.owned);
        return;
      }
      case "clear":
        chart?.instance.destroy();
        chart = null;
        return;
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
      queueMicrotask(() => {
        if (loads.get(generation) === load) step({ type: "loadFailed", generation });
      });
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
        free(owned);
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
        const checked = checkChartSpec(view.spec, { datasets: Object.keys(view.data) });
        if (!checked.ok) return of({ type: "blocked", sentence: checked.error });
        const ids = [...new Set(checked.names.map((name) => view.data[name].source_id))];
        return sources.versions(ids).pipe(
          map(() => {
            latest = viewPlan(view, checked.names, sources, number);
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
    destroy() {
      subscription.unsubscribe();
      step({ type: "destroy" });
    },
  };
}
