import {
  Observable,
  combineLatest,
  distinctUntilChanged,
  fromEvent,
  map,
  of,
  startWith,
  switchMap,
} from "rxjs";
import { checkViewSpec } from "../shared/view-spec.mjs";
import { OUTPUT_MAX_TOTAL_BYTES, OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { fetchOutputAsset } from "./output-assets.mjs";
import { mountAnywidgetOutput, readHostContext } from "@nteract/output-frame";
import { WIDGET_IMPORTS, widgetCatalogPin, localWidgetCatalog } from "./widget-imports.mjs";
import { themeStore } from "./theme.mjs";

export function anywidgetPlan(view, sources) {
  const checked = checkViewSpec(view.spec, view.data, view.media_type);
  if (!checked.ok) throw Error(checked.error);
  const versions = {};
  for (const { name, source, location, mediaType } of checked.dependencies) {
    const version = sources.resolve(source);
    if (mediaType && version.media_type !== mediaType)
      throw Error(`${location} source "${source.source_id}" must be ${mediaType}.`);
    versions[name] = version;
  }
  return { view, spec: checked.spec, versions, key: JSON.stringify([view, versions]) };
}

// One mount per resolved version set. A changed source cancels all loading
// and destroys the old frame before automatically rendering the new version.
export function mount(
  container,
  {
    view$,
    sources,
    sourcesAnswer$ = of("known"),
    frameUrl = container.ownerDocument.querySelector('meta[name="pages-output-frame-url"]')
      ?.content ?? OUTPUT_FRAME_URL,
    mountOutput = mountAnywidgetOutput,
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
  const catalog$ =
    localWidgetCatalog(frameUrl) && sources.sources$
      ? sources.sources$.pipe(
          map((all) => widgetCatalogPin(all[WIDGET_IMPORTS])),
          distinctUntilChanged(),
        )
      : of(null);
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
      return combineLatest([sources.versions(ids), sourcesAnswer$ ?? of("known"), catalog$]).pipe(
        map(([, , catalog]) => {
          try {
            const plan = anywidgetPlan(view, sources);
            const url = new URL(frameUrl);
            if (catalog) url.searchParams.set("catalog", catalog);
            return { ...plan, frameUrl: url.href, key: JSON.stringify([plan.key, catalog]) };
          } catch (error) {
            return { error: error.message };
          }
        }),
      );
    }),
    distinctUntilChanged((a, b) => a.key === b.key && a.error === b.error),
  );
  const subscription = plans$
    .pipe(
      switchMap(
        (plan) =>
          new Observable(() => {
            output.replaceChildren();
            title.textContent = plan.view?.title ?? "Interactive view";
            button.hidden = true;
            button.disabled = false;
            root.dataset.outputState = plan.error ? "unavailable" : "loading";
            message.textContent = plan.error ?? "Loading view…";
            if (plan.error) return;
            const activation = fromEvent(button, "click")
              .pipe(
                startWith(null),
                switchMap(
                  () =>
                    new Observable(() => {
                      const controller = new AbortController();
                      let outputHandle;
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
                      void (async () => {
                        try {
                          // Sequential bounded reads cap memory independently of number of bindings.
                          const assets = {};
                          let total = 0;
                          for (const [name, version] of Object.entries(plan.versions)) {
                            const asset = await fetchOutputAsset(sources.pageId, version, {
                              signal: controller.signal,
                              request: sources.request,
                            });
                            controller.signal.throwIfAborted();
                            total += asset.bytes.byteLength;
                            if (total > OUTPUT_MAX_TOTAL_BYTES)
                              throw Error("This view's inputs exceed 32 MiB.");
                            assets[name] = asset;
                          }
                          outputHandle = mountOutput(
                            output,
                            {
                              title: plan.view.title,
                              spec: plan.spec,
                              assets,
                            },
                            {
                              frameUrl: plan.frameUrl,
                              hostContext: readHostContext(root, theme.getSnapshot().resolved),
                              onState(state, error) {
                                if (controller.signal.aborted) return;
                                root.dataset.outputState = state;
                                message.textContent =
                                  error ?? (state === "ready" ? "" : "Starting interactive view…");
                                button.hidden = state !== "failed";
                                button.disabled = state !== "failed";
                              },
                            },
                          );
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
                        appearance();
                        outputHandle?.destroy();
                      };
                    }),
                ),
              )
              .subscribe();
            return () => activation.unsubscribe();
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
