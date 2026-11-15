import { Observable, Subscription, distinctUntilChanged, map, shareReplay, switchMap } from "rxjs";
import { ESM_VIEW_MEDIA_TYPE } from "../shared/esm-view.mjs";

// Preserve the editor's existing chart warm-up lease across the dispatcher.
export function warm(doc) {
  const lease = new Subscription();
  void import("./view-chart.mjs")
    .then((chart) => {
      if (!lease.closed) lease.add(chart.warm(doc));
    })
    .catch(() => {});
  return () => lease.unsubscribe();
}

// Select a renderer without teaching the chart executor about executable
// views. A media-type change tears down the previous renderer and its data.
export function mount(container, options) {
  const view$ = options.view$.pipe(shareReplay({ bufferSize: 1, refCount: true }));
  const subscription = view$
    .pipe(
      map((p) =>
        p.status === "ready" && p.view.media_type === ESM_VIEW_MEDIA_TYPE ? "esm" : "chart",
      ),
      distinctUntilChanged(),
      switchMap(
        (kind) =>
          new Observable((subscriber) => {
            let mounted;
            void (kind === "esm" ? import("./esm-view.mjs") : import("./view-chart.mjs"))
              .then((renderer) => {
                if (!subscriber.closed) mounted = renderer.mount(container, { ...options, view$ });
              })
              .catch(() => {
                if (!subscriber.closed) container.textContent = "This view couldn't be loaded.";
              });
            return () => {
              mounted?.destroy();
              container.replaceChildren();
            };
          }),
      ),
    )
    .subscribe();
  return {
    destroy() {
      subscription.unsubscribe();
    },
  };
}
