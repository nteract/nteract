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
import { ESM_MEDIA_TYPE, OUTPUT_MAX_TOTAL_BYTES, OUTPUT_FRAME_URL } from "../shared/esm-view.mjs";
import { fetchOutputAsset } from "./output-assets.mjs";
import { mountEsmOutput, readHostContext } from "@nteract/output-frame";
import { themeStore } from "./theme.mjs";

export function esmPlan(view, sources) {
  const checked = checkViewSpec(view.spec, view.data, view.media_type);
  if (!checked.ok) throw Error(checked.error);
  const versions = Object.fromEntries(
    checked.names.map((name) => [name, sources.resolve(view.data[name])]),
  );
  if (versions[view.spec.module].media_type !== ESM_MEDIA_TYPE)
    throw Error("The module source must be text/javascript.");
  return { view, versions, key: JSON.stringify([view, versions]) };
}

// One mount per resolved version set. A changed source cancels all loading
// and destroys the old frame before automatically rendering the new version.
export function mount(
  container,
  {
    view$,
    sources,
    sourcesAnswer$ = of("known"),
    frameUrl = OUTPUT_FRAME_URL,
    mountOutput = mountEsmOutput,
    theme = themeStore,
  },
) {
  const doc = container.ownerDocument;
  const root = container.appendChild(doc.createElement("section"));
  root.className = "pages-esm-view";
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
      return combineLatest([
        sources.versions(Object.values(view.data).map((b) => b.source_id)),
        sourcesAnswer$ ?? of("known"),
      ]).pipe(
        map(() => {
          try {
            return esmPlan(view, sources);
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
                          const module = assets[plan.view.spec.module];
                          delete assets[plan.view.spec.module];
                          outputHandle = mountOutput(
                            output,
                            {
                              title: plan.view.title,
                              module,
                              inputs: assets,
                              state: plan.view.spec.state ?? {},
                            },
                            {
                              ...(frameUrl && { frameUrl }),
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
