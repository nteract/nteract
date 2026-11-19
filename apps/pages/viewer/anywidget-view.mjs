import { openAssetByteSource } from "./asset-byte-source.mjs";
import {
  BehaviorSubject,
  Observable,
  combineLatest,
  distinctUntilChanged,
  filter,
  fromEvent,
  groupBy,
  map,
  mergeMap,
  of,
  scan,
  share,
  startWith,
  switchMap,
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
import { hasWidgetCatalog } from "./widget-imports.mjs";
import { themeStore } from "./theme.mjs";

const sameAsset = (a, b) => a?.asset_id === b?.asset_id && a?.media_type === b?.media_type;
const asset = (version) => ({ asset_id: version.asset_id, media_type: version.media_type });

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
// input and hands it to the mounted frame; a title change relabels it.
export function mount(
  container,
  {
    view$,
    sources,
    sourcesAnswer$ = of("known"),
    frameUrl = container.ownerDocument.querySelector('meta[name="pages-output-frame-url"]')
      ?.content ?? OUTPUT_FRAME_URL,
    mountOutput = mountModuleOutput,
    theme = themeStore,
  },
) {
  const doc = container.ownerDocument;
  const root = container.appendChild(doc.createElement("section"));
  root.className = "pages-anywidget-view";
  const title = root.appendChild(doc.createElement("h3"));
  const message = root.appendChild(doc.createElement("p"));
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
            const activation = fromEvent(button, "click")
              .pipe(
                startWith(null),
                switchMap(
                  () =>
                    new Observable(() => {
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
                      // Bytes the frame holds, by name. Each change replaces
                      // its name's share of the view's total.
                      const sizes = new Map();
                      const admit = (name, size) => {
                        let total = size;
                        for (const [other, held] of sizes) if (other !== name) total += held;
                        if (total > OUTPUT_MAX_TOTAL_BYTES)
                          throw Error("This view's inputs exceed 32 MiB.");
                        sizes.set(name, size);
                      };
                      const loadBytes = async (version, signal) => {
                        const loaded = await fetchOutputAsset(sources.pageId, version, {
                          signal,
                          request: sources.request,
                        });
                        signal.throwIfAborted();
                        return loaded;
                      };
                      // A module view reads a Parquet file in ranges; every
                      // other data input arrives whole.
                      const loadData = async (name, version, signal) => {
                        if (module && version.media_type === PARQUET_MEDIA_TYPE) {
                          const file = await openAssetByteSource(sources.pageId, version, {
                            signal,
                            request: sources.request,
                          });
                          signal.throwIfAborted();
                          return { value: file, size: 0 };
                        }
                        const { bytes } = await loadBytes(version, signal);
                        return { value: bytes, size: bytes.byteLength };
                      };
                      // Data changes that failed to load, by name. The frame
                      // keeps the data it has for those names.
                      const failures = new Map();
                      const showFailures = () => {
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
                      // or the mount ends. Once handed to the frame, a ranged
                      // file reads under the mount's signal, not the load's.
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
                              admit(name, input.size);
                              outputHandle.setData(name, input.value);
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
                        try {
                          // Sequential bounded reads cap memory independently of number of bindings.
                          const assets = {};
                          const url = new URL(frameUrl);
                          const imports = {};
                          const catalogRevision = plan.view.catalog_revision;
                          if (catalogRevision) {
                            if (!hasWidgetCatalog(frameUrl))
                              throw Error(
                                "This output host cannot serve the catalog pinned by this view.",
                              );
                            url.searchParams.set("catalog", catalogRevision);
                          }
                          const byteSources = {};
                          for (const [name, version] of Object.entries(plan.versions)) {
                            if (name.startsWith("data/")) {
                              const input = await loadData(name, version, controller.signal);
                              admit(name, input.size);
                              byteSources[name] = input.value;
                            } else {
                              const loaded = await loadBytes(version, controller.signal);
                              admit(name, loaded.bytes.byteLength);
                              if (name.startsWith("import/")) imports[name.slice(7)] = loaded;
                              else assets[name] = loaded;
                            }
                          }
                          controller.signal.throwIfAborted();
                          outputHandle = mountOutput(
                            output,
                            {
                              title: plan.view.title,
                              ...(module ? { kind: "module" } : { spec: plan.spec }),
                              assets,
                              ...(Object.keys(imports).length && { imports }),
                            },
                            {
                              byteSources,
                              frameUrl: url.href,
                              hostContext: readHostContext(root, theme.getSnapshot().resolved),
                              onState(state, error) {
                                if (controller.signal.aborted) return;
                                root.dataset.outputState = state;
                                message.textContent =
                                  error ?? (state === "ready" ? "" : "Starting interactive view…");
                                button.hidden = state !== "failed";
                                button.disabled = state !== "failed";
                                if (state === "ready") showFailures();
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
                                name$.pipe(switchMap(([name, version]) => update(name, version))),
                              ),
                            )
                            .subscribe();
                        } catch (error) {
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
