type Layout = Record<string, unknown>;

function object(value: unknown): Layout {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Layout)
    : {};
}

function cartesianAxes(layout: Layout): string[] {
  const template = object(object(layout.template).layout);
  return [...new Set(["xaxis", "yaxis", ...Object.keys(template), ...Object.keys(layout)])].filter(
    (key) => /^[xy]axis(?:[2-9]|[1-9]\d+)?$/.test(key),
  );
}

const DARK_COLORWAY = [
  "#636efa",
  "#ef553b",
  "#00cc96",
  "#ab63fa",
  "#ffa15a",
  "#19d3f3",
  "#ff6692",
  "#b6e880",
  "#ff97ff",
  "#fecb52",
];

/** Color-only relayout paths leave axis semantics and interactive ranges untouched. */
export function plotlyThemeUpdate(layout: Layout, isDark: boolean): Layout {
  const text = isDark ? "rgba(200, 200, 200, 1)" : "rgba(68, 68, 68, 1)";
  const grid = isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)";
  const update: Layout = {
    paper_bgcolor: "transparent",
    plot_bgcolor: isDark ? "rgba(30, 30, 30, 1)" : "rgba(255, 255, 255, 1)",
    "font.color": text,
    "legend.font.color": text,
    // null resets Plotly's default on a return to light mode. Explicit layout palettes survive.
    colorway: layout.colorway ?? (isDark ? [...DARK_COLORWAY] : null),
  };
  for (const axis of cartesianAxes(layout)) {
    update[`${axis}.gridcolor`] = grid;
    update[`${axis}.zerolinecolor`] = grid;
    update[`${axis}.color`] = text;
  }
  return update;
}

/** Apply the same color policy at creation without replacing user layout objects. */
export function withPlotlyTheme(layout: Layout, isDark: boolean): Layout {
  const update = plotlyThemeUpdate(layout, isDark);
  const legend = object(layout.legend);
  const themed: Layout = {
    ...layout,
    paper_bgcolor: update.paper_bgcolor,
    plot_bgcolor: update.plot_bgcolor,
    colorway: update.colorway,
    font: { ...object(layout.font), color: update["font.color"] },
    legend: {
      ...legend,
      font: { ...object(legend.font), color: update["legend.font.color"] },
    },
  };
  for (const axis of cartesianAxes(layout)) {
    themed[axis] = {
      ...object(layout[axis]),
      gridcolor: update[`${axis}.gridcolor`],
      zerolinecolor: update[`${axis}.zerolinecolor`],
      color: update[`${axis}.color`],
    };
  }
  return themed;
}
