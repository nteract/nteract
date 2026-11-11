// A dataframe node's chart (dataframe-chart.mjs, the local dataframe-chart
// feature). vega-chart.mjs draws it; this module says where each data
// name's rows come from.
//
// - A node with `source`, on a Page with its `sources` store: each data name
//   is a Page source ID. The chart redraws when one of them changes.
// - Otherwise every name reads the node's `src`, the asset it was written
//   with. A card has no store, so a chart over several sources draws only
//   its `source` there.
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { chartBinding, markSourceVersions } from "./page-source-store.mjs";
import { createPageSourceResolver } from "./page-source-resolver.mjs";
import { mount as mountChart } from "./vega-chart.mjs";
import { skip } from "rxjs";

/** Mount the chart for `chart` (a Vega-Lite JSON string). `loadTableFile`
 * is Sift's decoder; dataframe-chart.mjs supplies it. Returns
 * `{ update, destroy }`. */
export function mountSourceChart(
  container,
  { src, pageId, chart, source, sources, onReport, loadTableFile },
) {
  let spec;
  try {
    spec = JSON.parse(chart);
  } catch {
    spec = null;
  }
  const following = !!(source && sources);
  // A card has no Page store: its own resolver, freed with the chart.
  const own = sources
    ? null
    : createPageSourceResolver({ pageId, readBinding: (binding) => binding, loadTableFile });
  const resolver = own ?? sources.resolver(loadTableFile);
  const resolveSource = async (name, options) =>
    resolver.resolveSource(chartBinding(name, { src, source, following }), options);
  const mounted = mountChart(container, {
    spec,
    resolveSource,
    onReport(report) {
      if (report.sources) markSourceVersions(container, report.sources);
      onReport?.(report);
    },
  });
  const names = spec ? checkChartSpec(spec).sources : [];
  const refresh = following
    ? sources
        .versions(names)
        .pipe(skip(1))
        .subscribe(() => mounted.update(spec))
    : null;
  return {
    ...mounted,
    destroy() {
      refresh?.unsubscribe();
      mounted.destroy();
      own?.destroy();
    },
  };
}
