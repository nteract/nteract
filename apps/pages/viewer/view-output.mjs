import { Observable, distinctUntilChanged, scan, shareReplay, switchMap } from "rxjs";
import { viewPlaceholder } from "./view-placeholder.mjs";
import { isExecutableView } from "../shared/anywidget-view.mjs";

// Select a renderer without teaching the chart executor about executable
// views. A media-type change tears down the previous renderer and its data.
export function mount(container, options) {
  const view$ = options.view$.pipe(shareReplay({ bufferSize: 1, refCount: true }));
  const subscription = view$
    .pipe(
      scan(
        (previous, p) =>
          p.status !== "ready"
            ? previous
            : isExecutableView(p.view.media_type)
              ? "anywidget"
              : "chart",
        "placeholder",
      ),
      distinctUntilChanged(),
      switchMap(
        (kind) =>
          new Observable((subscriber) => {
            if (kind === "placeholder") {
              const { placeholder, message } = viewPlaceholder(container);
              const status = view$.subscribe((projection) => {
                placeholder.dataset.viewState =
                  projection.status === "unavailable" ? "blocked" : "waiting";
                message.textContent = projection.sentence ?? "Loading view…";
              });
              return () => {
                status.unsubscribe();
                placeholder.remove();
              };
            }
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
            let mounted, release;
            void (
              kind === "anywidget" ? import("./anywidget-view.mjs") : import("./view-chart.mjs")
            )
              .then((renderer) => {
                if (subscriber.closed) return;
                release = renderer.warm?.(container.ownerDocument);
                mounted = renderer.mount(container, { ...options, view$ });
              })
              .catch(() => {
                if (!subscriber.closed) container.textContent = "This view couldn't be loaded.";
              });
            return () => {
              mounted?.destroy();
              release?.();
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
