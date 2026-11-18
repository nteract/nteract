import { Observable, Subscription, distinctUntilChanged, map, shareReplay, switchMap } from "rxjs";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";

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
        p.status === "ready" && p.view.media_type === ANYWIDGET_MEDIA_TYPE ? "anywidget" : "chart",
      ),
      distinctUntilChanged(),
      switchMap(
        (kind) =>
          new Observable((subscriber) => {
            // A grid card is a raster image. Its renderer cannot read an
            // opaque widget frame. Draw its caption without mounting code.
            if (kind === "anywidget" && options.card) {
              const caption = container.ownerDocument.createElement("p");
              caption.dataset.widgetCaption = "";
              container.append(caption);
              const titles = view$.subscribe(({ view }) => {
                caption.textContent = view?.title || "Interactive view";
              });
              return () => {
                titles.unsubscribe();
                caption.remove();
              };
            }
            let mounted;
            void (
              kind === "anywidget" ? import("./anywidget-view.mjs") : import("./view-chart.mjs")
            )
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
