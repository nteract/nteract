import { openAssetByteSource } from "./asset-byte-source.mjs";
import {
  BehaviorSubject,
  Observable,
  combineLatest,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  groupBy,
  lastValueFrom,
  map,
  merge,
  mergeMap,
  of,
  scan,
  share,
  startWith,
  Subject,
  switchMap,
  toArray,
} from "rxjs";
import { checkViewSpec } from "../shared/view-spec.mjs";
import {
  MODULE_MEDIA_TYPE,
  OUTPUT_MAX_TOTAL_BYTES,
  OUTPUT_FRAME_URL,
} from "../shared/anywidget-view.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { fetchOutputAsset } from "./output-assets.mjs";
import { mountModuleOutput, readHostContext } from "@nteract/output-frame";
import { hostLibraryRevision, libraryMap$ } from "./library-catalog.mjs";
import { themeStore } from "./theme.mjs";

// How many of a view's inputs load at once while it mounts. This bounds the
// bytes arriving before the total check (OUTPUT_MAX_TOTAL_BYTES) counts
// them: a load in flight holds at most two copies of an input of
// OUTPUT_MAX_BYTES, its chunks and the bytes assembled from them
// (output-assets.mjs fetchOutputAsset).
const MOUNT_LOADS = 6;

const sameAsset = (a, b) => a?.asset_id === b?.asset_id && a?.media_type === b?.media_type;
const asset = (version) => ({ asset_id: version.asset_id, media_type: version.media_type });

// The table decoder, in a chunk of its own: only a module view that calls
// parquet() or csv() loads it.
const loadColumnDecoder = () => import("./module-parquet.mjs").then((m) => m.parquetColumns);

// The frame runtime from this build (scripts/build-output.mjs writes it), in a
// chunk of its own that loads with the first view's frame. The output host
// serves only a bootstrap, so the runtime always matches this viewer. A failed
// load is not kept: Retry asks again.
let frameRuntimeText;
const loadFrameRuntime = () =>
  (frameRuntimeText ??= import("../.output-dist/frame-runtime.mjs").then(
    (m) => m.FRAME_RUNTIME,
    (error) => {
      frameRuntimeText = undefined;
      throw error;
    },
  ));

// A plan splits a view into its code identity, `key`, and its data inputs,
// `data`: name → asset. The frame's lifetime follows `key` alone.
// - Code: the media type, the stored spec, the catalog revision, and the asset
//   of every other dependency: a module view's entry and imports, an
//   anywidget's modules and stylesheets.
// - Data: a module view's data/<alias> files; an anywidget's sources used
//   only as buffers.
// The title, the view revision and its producer are neither.
export function anywidgetPlan(view, sources) {
  const checked = checkViewSpec(view.spec, view.data, view.media_type);
  if (!checked.ok) throw Error(checked.error);
  const versions = {};
  const roles = new Map();
  for (const { name, source, location, mediaType, role } of checked.dependencies) {
    const version = sources.resolve(source);
    if (mediaType && version.media_type !== mediaType)
      throw Error(`${location} source "${source.source_id}" must be ${mediaType}.`);
    versions[name] = version;
    roles.set(name, [...(roles.get(name) ?? []), role]);
  }
  const module = view.media_type === MODULE_MEDIA_TYPE;
  const code = {};
  const data = {};
  for (const [name, version] of Object.entries(versions)) {
    const isData = module
      ? name.startsWith("data/")
      : roles.get(name).every((role) => role === "buffer");
    (isData ? data : code)[name] = asset(version);
  }
  const key = JSON.stringify([view.media_type, view.spec, view.catalog_revision ?? null, code]);
  return { view, spec: checked.spec, versions, data, key };
}

const REMOUNT = Object.freeze({ kind: "remount", data: Object.freeze([]), title: false });
const NONE = Object.freeze({ kind: "none", data: Object.freeze([]), title: false });

// What moving from one plan to the next does to a mounted view:
// - "remount": the code identity changed, or either plan is a different error;
// - "data": these data names moved to another asset (`title` says whether the
//   title changed too);
// - "title": only the title changed;
// - "none": nothing visible changed (a revision or producer rewrite).
export function planChange(previous, next) {
  if (previous.error !== undefined || next.error !== undefined)
    return previous.error === next.error ? NONE : REMOUNT;
  if (previous.key !== next.key) return REMOUNT;
  const data = Object.keys(next.data).filter(
    (name) => !sameAsset(previous.data[name], next.data[name]),
  );
  const title = previous.view.title !== next.view.title;
  if (data.length) return { kind: "data", data, title };
  return title ? { kind: "title", data: [], title } : NONE;
}

// One mount per code identity. A code change cancels all loading and destroys
// the old frame before rendering the new code. A data change loads the new
// input and hands it to the mounted frame; a view with no listener for it is
// mounted again. A title change relabels it.
export function mount(
  container,
  {
    view$,
    sources,
    sourcesAnswer$ = of("known"),
    frameUrl = container.ownerDocument.querySelector('meta[name="pages-output-frame-url"]')
      ?.content ?? OUTPUT_FRAME_URL,
    // The deployment is on a private address with a public output host
    // (worker/output-frame-config.mjs): delegate local-network to the frame.
    localNetwork = container.ownerDocument.querySelector(
      'meta[name="pages-output-frame-local-network"]',
    )?.content === "true",
    mountOutput = mountModuleOutput,
    // Resolves with the frame runtime's text, which the output host's
    // bootstrap runs.
    frameRuntime = loadFrameRuntime,
    theme = themeStore,
    // The most bytes one view's frame holds from mount: its entry, imports
    // and anywidget assets and buffers.
    maxTotalBytes = OUTPUT_MAX_TOTAL_BYTES,
    // Resolves with the decoder `sources.sharedResolver` decodes Parquet
    // files and converted CSV files to ColumnSets with (parquet-columns.mjs).
    columnDecoder = loadColumnDecoder,
    // Resolves a view's pin to the library map it mounts with
    // (library-catalog.mjs libraryMap$): the pinned catalog while this
    // origin serves it, otherwise the one this build carries.
    libraryMap = (pin) =>
      libraryMap$(pin, {
        origin: container.ownerDocument.location.origin,
        current: hostLibraryRevision(),
      }),
  },
) {
  const doc = container.ownerDocument;
  const root = container.appendChild(doc.createElement("section"));
  root.className = "pages-anywidget-view";
  const title = root.appendChild(doc.createElement("h3"));
  const message = root.appendChild(doc.createElement("p"));
  // A pointer selection in the status line belongs to the browser, including Copy.
  message.tabIndex = -1;
  const button = root.appendChild(doc.createElement("button"));
  button.type = "button";
  button.textContent = "Retry interactive view";
  const output = root.appendChild(doc.createElement("div"));
  const plans$ = view$.pipe(
    switchMap((projection) => {
      if (projection.status !== "ready")
        return of({ error: projection.sentence ?? "Loading view…" });
      const view = projection.view;
      let ids;
      try {
        ids = [...new Set(viewDependencies(view).map(({ source }) => source.source_id))];
      } catch (error) {
        return of({ error: error.message });
      }
      return combineLatest([sources.versions(ids), sourcesAnswer$ ?? of("known")]).pipe(
        map(() => {
          try {
            return anywidgetPlan(view, sources);
          } catch (error) {
            return { error: error.message };
          }
        }),
      );
    }),
    share(),
  );
  const subscription = plans$
    .pipe(
      distinctUntilChanged((a, b) => planChange(a, b).kind !== "remount"),
      switchMap(
        (first) =>
          new Observable(() => {
            output.replaceChildren();
            title.textContent = first.view?.title ?? "Interactive view";
            button.hidden = true;
            button.disabled = false;
            root.dataset.outputState = first.error ? "unavailable" : "loading";
            message.textContent = first.error ?? "Loading view…";
            delete root.dataset.inputError;
            if (first.error) return;
            // The newest plan with this code. A mount starts from it, and
            // later data and title changes are measured against it.
            const latest$ = new BehaviorSubject(first);
            const follow = plans$
              .pipe(filter((plan) => planChange(first, plan).kind !== "remount"))
              .subscribe((plan) => latest$.next(plan));
            let outputHandle;
            const titles = latest$
              .pipe(
                map((plan) => plan.view.title),
                distinctUntilChanged(),
              )
              .subscribe((text) => {
                title.textContent = text ?? "Interactive view";
                if (outputHandle) outputHandle.frame.title = text || "Interactive output";
              });
            // A mount starts on first render, on Retry, and when the frame
            // reports a data change no listener in the view would show. Each
            // starts from the newest plan, so nothing is left to redeliver.
            const remount$ = new Subject();
            // Each mount first settles the view's library map from this
            // origin's manifests. No frame mounts until it is known: a
            // manifest that fails to load leaves the view unavailable, with
            // Retry, which asks again. A host with no libraries mounts the
            // view without a map.
            const unavailable = (text) =>
              new Observable(() => {
                root.dataset.outputState = "failed";
                message.textContent = text;
                button.disabled = false;
                button.hidden = false;
              });
            const activation = merge(fromEvent(button, "click"), remount$)
              .pipe(
                startWith(null),
                switchMap(() => {
                  button.disabled = true;
                  button.hidden = true;
                  root.dataset.outputState = "loading";
                  message.textContent = "Loading view libraries…";
                  delete root.dataset.inputError;
                  return libraryMap(latest$.value.view.catalog_revision ?? null).pipe(
                    switchMap((outcome) =>
                      outcome.kind === "failed"
                        ? unavailable(outcome.message)
                        : new Observable(() => {
                            const libraries = outcome.libraries;
                            const controller = new AbortController();
                            let changes;
                            // Presentation changes do not change code/input identity.
                            const appearance = theme.subscribe(() =>
                              outputHandle?.setHostContext(
                                readHostContext(root, theme.getSnapshot().resolved),
                              ),
                            );
                            button.disabled = true;
                            button.hidden = true;
                            message.textContent = "Loading view inputs…";
                            root.dataset.outputState = "loading";
                            delete root.dataset.inputError;
                            const plan = latest$.value;
                            const module = plan.view.media_type === MODULE_MEDIA_TYPE;
                            // Bytes the frame holds from mount, by name: the entry,
                            // imports and anywidget assets and buffers. Each buffer
                            // change replaces its name's share of the view's total.
                            // A size is recorded only once the frame holds it. A
                            // module view's files count nothing here; the frame
                            // host keeps their whole-file total itself.
                            const sizes = new Map();
                            const checkTotal = (name, size) => {
                              let total = size;
                              for (const [other, held] of sizes) if (other !== name) total += held;
                              if (total > maxTotalBytes)
                                throw Error(
                                  `This view's inputs exceed ${maxTotalBytes / (1024 * 1024)} MiB.`,
                                );
                            };
                            const loadBytes = async (version, signal) => {
                              const loaded = await fetchOutputAsset(sources.pageId, version, {
                                signal,
                                request: sources.request,
                              });
                              signal.throwIfAborted();
                              return loaded;
                            };
                            // A module view's file is opened for its size at
                            // mount and read only when the view asks: ranges from
                            // the asset, the whole file through fetchOutputAsset
                            // (5 MiB), and a ColumnSet from Parquet or CSV through
                            // the Page's shared cache, so views of one asset decode
                            // it once per format. Those reads run under the mount and the
                            // frame's request, not this load. An anywidget buffer
                            // arrives whole.
                            const loadData = async (name, version, signal) => {
                              if (!module) {
                                const { bytes } = await loadBytes(version, signal);
                                return { value: bytes, size: bytes.byteLength };
                              }
                              const file = await openAssetByteSource(sources.pageId, version, {
                                signal,
                                request: sources.request,
                              });
                              signal.throwIfAborted();
                              const within = (request) =>
                                AbortSignal.any([controller.signal, request]);
                              const input = {
                                mimeType: version.media_type,
                                byteLength: file.byteLength,
                                read: file.read,
                                bytes: async (request) =>
                                  (await loadBytes(version, within(request))).bytes,
                              };
                              // parquet() reads a Parquet source; csv() reads any
                              // file, converted once in the source store.
                              input.columns = async (format, request) => {
                                if (
                                  format === "parquet" &&
                                  version.media_type !== PARQUET_MEDIA_TYPE
                                )
                                  throw Error("This file is not Parquet.");
                                const decode = await columnDecoder();
                                const loaded = await sources
                                  .sharedResolver(decode, { format })
                                  .load(version, { signal: within(request) });
                                return loaded.table;
                              };
                              return { value: input, size: 0 };
                            };
                            // Data changes that failed to load, by name. The frame
                            // keeps the data it has for those names.
                            const failures = new Map();
                            // Shown only on a ready frame: a frame still starting
                            // has no earlier data, and a failed one owns the
                            // message and Retry.
                            const showFailures = () => {
                              if (root.dataset.outputState !== "ready") return;
                              if (!failures.size) {
                                if (root.dataset.inputError === undefined) return;
                                delete root.dataset.inputError;
                                message.textContent = "";
                                button.hidden = true;
                                button.disabled = true;
                                return;
                              }
                              root.dataset.inputError = [...failures.keys()].join(" ");
                              message.textContent = `This view still shows its earlier data. ${[...failures.values()][0]}`;
                              button.hidden = false;
                              button.disabled = false;
                            };
                            // A load ends when a newer change for its name arrives
                            // or the mount ends. Once handed to the frame, a file
                            // reads under the mount's signal, not the load's.
                            const update = (name, version) =>
                              new Observable((subscriber) => {
                                const loading = new AbortController();
                                let delivered = false;
                                void (async () => {
                                  try {
                                    const input = await loadData(
                                      name,
                                      version,
                                      AbortSignal.any([controller.signal, loading.signal]),
                                    );
                                    if (loading.signal.aborted) return;
                                    checkTotal(name, input.size);
                                    outputHandle.setData(name, input.value);
                                    sizes.set(name, input.size);
                                    delivered = true;
                                    failures.delete(name);
                                  } catch (error) {
                                    if (loading.signal.aborted) return;
                                    failures.set(name, error.message);
                                  }
                                  showFailures();
                                  subscriber.complete();
                                })();
                                return () => delivered || loading.abort();
                              });
                            void (async () => {
                              // Ends the loads still running when this mount
                              // fails.
                              const loads = new AbortController();
                              try {
                                // The inputs load MOUNT_LOADS at a time, and the
                                // frame starts only once every one is here.
                                // Nothing depends on the order they arrive in:
                                // the maps the frame gets keep the plan's order.
                                // Each input counts toward the total as it
                                // arrives, so the bytes held stay within the
                                // total plus MOUNT_LOADS loads in flight.
                                const signal = AbortSignal.any([controller.signal, loads.signal]);
                                const entries = Object.entries(plan.versions);
                                const loaded = new Map(
                                  await lastValueFrom(
                                    from(entries).pipe(
                                      mergeMap(async ([name, version]) => {
                                        if (name.startsWith("data/"))
                                          return [name, await loadData(name, version, signal)];
                                        const input = await loadBytes(version, signal);
                                        checkTotal(name, input.bytes.byteLength);
                                        sizes.set(name, input.bytes.byteLength);
                                        return [name, input];
                                      }, MOUNT_LOADS),
                                      toArray(),
                                    ),
                                  ),
                                );
                                const assets = {};
                                const imports = {};
                                const files = {};
                                for (const [name] of entries) {
                                  const input = loaded.get(name);
                                  if (name.startsWith("data/")) files[name] = input.value;
                                  else if (name.startsWith("import/"))
                                    imports[name.slice(7)] = input;
                                  else assets[name] = input;
                                }
                                controller.signal.throwIfAborted();
                                outputHandle = mountOutput(
                                  output,
                                  {
                                    // The newest title: it may have changed while
                                    // inputs loaded.
                                    title: latest$.value.view.title,
                                    ...(module ? { kind: "module" } : { spec: plan.spec }),
                                    assets,
                                    ...(Object.keys(imports).length && { imports }),
                                    ...(libraries && { libraries }),
                                    ...(outcome.integrity && {
                                      libraryIntegrity: outcome.integrity,
                                    }),
                                  },
                                  {
                                    files,
                                    frameUrl,
                                    localNetwork,
                                    runtime: frameRuntime,
                                    hostContext: readHostContext(
                                      root,
                                      theme.getSnapshot().resolved,
                                    ),
                                    onState(state, error) {
                                      if (controller.signal.aborted) return;
                                      root.dataset.outputState = state;
                                      message.textContent =
                                        error ??
                                        (state === "ready" ? "" : "Starting interactive view…");
                                      button.hidden = state !== "failed";
                                      button.disabled = state !== "failed";
                                      if (state === "ready") showFailures();
                                      else delete root.dataset.inputError;
                                    },
                                    onUnhandledData() {
                                      if (!controller.signal.aborted) remount$.next();
                                    },
                                  },
                                );
                                // Each data name follows its newest asset. A newer
                                // change cancels that name's load in progress.
                                changes = latest$
                                  .pipe(
                                    scan(
                                      (previous, next) => ({
                                        plan: next,
                                        names: planChange(previous.plan, next).data,
                                      }),
                                      { plan, names: [] },
                                    ),
                                    mergeMap(({ plan: next, names }) =>
                                      names.map((name) => [name, next.versions[name]]),
                                    ),
                                    groupBy(([name]) => name),
                                    mergeMap((name$) =>
                                      name$.pipe(
                                        switchMap(([name, version]) => update(name, version)),
                                      ),
                                    ),
                                  )
                                  .subscribe();
                              } catch (error) {
                                loads.abort();
                                if (controller.signal.aborted) return;
                                root.dataset.outputState = "failed";
                                message.textContent = error.message;
                                button.disabled = false;
                                button.hidden = false;
                              }
                            })();
                            return () => {
                              controller.abort();
                              changes?.unsubscribe();
                              appearance();
                              outputHandle?.destroy();
                              outputHandle = undefined;
                            };
                          }),
                    ),
                  );
                }),
              )
              .subscribe();
            return () => {
              activation.unsubscribe();
              titles.unsubscribe();
              follow.unsubscribe();
            };
          }),
      ),
    )
    .subscribe();
  return {
    destroy() {
      subscription.unsubscribe();
      root.remove();
    },
  };
}
