// A view embed's DOM: the chart vega-chart.mjs mounts, and, while there is
// no chart to show, the same bare frame with one sentence in it. The drawing
// itself is view-draw.mjs; this module only renders what it reports.
//
// The embed is bare: the view's title, the chart in one thin border, and the
// Maximize and optional comment controls the chart renderer adds. A chart drawn without some of its
// data carries one sentence under it naming the source.
import { viewPlaceholder } from "./view-placeholder.mjs";
import { createViewDraw } from "./view-draw.mjs";

/**
 * Mount the view `view$` projects (view-store.mjs) into `container`.
 * `sources` is the Page's source store, and `sourcesAnswer$` what the Page
 * knows about its document (view-draw.mjs); `decode`,
 * `checkChartSpec` and `mount` are the chart chunk's (view-chart.mjs).
 * Returns `{ destroy }`.
 */
export function mountViewEmbed(
  container,
  { view$, sources, sourcesAnswer$, decode, checkChartSpec, mount, comments = null },
) {
  const doc = container.ownerDocument;
  const root = container.appendChild(doc.createElement("div"));
  root.className = "pages-view";
  const chart = root.appendChild(doc.createElement("div"));
  chart.className = "pages-view-chart";
  const { placeholder, header, title, message } = viewPlaceholder(root);
  const note = root.appendChild(doc.createElement("p"));
  note.className = "pages-view-note";
  note.hidden = true;

  const draw = createViewDraw({
    view$,
    sources,
    ...(sourcesAnswer$ && { sourcesAnswer$ }),
    decode,
    checkChartSpec,
    render: {
      draw({ view, datasets }) {
        // The chart measures its container's width as it mounts, so the
        // container is laid out first: a hidden one is 0 wide, and the chart
        // would draw at its own step width and redraw once it shows. `show`
        // runs right after and settles both.
        chart.hidden = false;
        placeholder.hidden = true;
        return mount(chart, {
          spec: view.spec,
          datasets,
          title: view.title,
          ...(comments && { comments }),
        });
      },
      show(status) {
        root.dataset.viewState = status.state;
        const placing = status.sentence !== null;
        placeholder.hidden = !placing;
        chart.hidden = placing;
        message.textContent = status.sentence ?? "";
        title.textContent = status.title ?? "";
        header.hidden = !status.title;
        placeholder.setAttribute("aria-label", status.title || "Chart");
        note.hidden = !status.note || placing;
        note.textContent = status.note ?? "";
      },
    },
  });

  return {
    get state() {
      return draw.state;
    },
    destroy() {
      draw.destroy();
      root.remove();
    },
  };
}
