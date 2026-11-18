import { createElement as h, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ToggleGroup, ToggleGroupItem, Separator } from "@nteract/pages-ui";
import * as Plot from "@observablehq/plot";
import { max } from "d3";

function Activity({ days }) {
  const [window, setWindow] = useState("7");
  const drawing = useRef(null);
  useEffect(() => {
    const rows = days.slice(-Number(window));
    const dates = rows.map((day) => day.date);
    const container = drawing.current;
    function draw() {
      const chart = Plot.plot({
        width: Math.max(220, container.clientWidth),
        height: 165,
        marginTop: 12,
        marginLeft: 28,
        marginBottom: 32,
        x: {
          type: "band",
          label: null,
          domain: dates,
          ticks: dates.filter(
            (_, i) => i % Math.ceil(dates.length / Math.max(2, container.clientWidth / 65)) === 0,
          ),
        },
        y: { grid: true, label: null, ticks: 3, domain: [0, max(days, (d) => d.people)] },
        marks: [
          Plot.barY(rows, {
            x: "date",
            y: "people",
            fill: "var(--primary)",
            rx: 2,
            title: (d) => d.date + " · " + d.people + " active",
          }),
          Plot.ruleY([0]),
        ],
      });
      container.replaceChildren(chart);
    }
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [days, window]);
  return h(
    "div",
    null,
    h(
      ToggleGroup,
      {
        type: "single",
        value: window,
        onValueChange: (v) => v && setWindow(v),
        "aria-label": "Activity window",
      },
      ...["7", "14"].map((v) => h(ToggleGroupItem, { key: v, value: v }, v + " days")),
    ),
    h(Separator),
    h("p", { style: { marginTop: "0.75rem" } }, "Daily active people · last " + window + " days"),
    h("div", { ref: drawing }),
  );
}

export default {
  render({ el, model }) {
    const root = createRoot(el);
    root.render(h(Activity, { days: model.get("days") }));
    return () => root.unmount();
  },
};
