import activity from "data/activity";
import { createElement as h, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChoiceGroup } from "activity-controls";
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
    h(ChoiceGroup, {
      label: "Activity window",
      value: window,
      onChange: setWindow,
      options: [
        ["7", "7 days"],
        ["14", "14 days"],
      ],
    }),
    h("p", { style: { marginTop: "0.75rem" } }, "Daily active people · last " + window + " days"),
    h("div", { ref: drawing }),
  );
}

export async function render({ el, signal }) {
  const bytes = await activity.read(0, activity.byteLength, signal);
  const { days } = JSON.parse(new TextDecoder().decode(bytes));
  signal.throwIfAborted();
  const root = createRoot(el);
  root.render(h(Activity, { days }));
  return () => root.unmount();
}
