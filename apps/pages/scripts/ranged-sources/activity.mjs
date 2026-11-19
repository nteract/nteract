import activity from "data/activity";
import { loadTableFile } from "@nteract/sift/parquet";
import * as Plot from "@observablehq/plot";

export async function render({ el, signal }) {
  let reads = 0,
    transferred = 0;
  const table = await loadTableFile(
    {
      byteLength: activity.byteLength,
      async read(offset, length) {
        const bytes = await activity.read(offset, length, signal);
        reads++;
        transferred += bytes.length;
        return bytes;
      },
    },
    { format: "parquet", maxRows: 28, overflow: "truncate" },
  );
  let rows;
  try {
    const index = (name) => table.columns.findIndex((c) => c.label === name);
    const day = index("day"),
      people = index("active_people");
    rows = Array.from({ length: table.rowCount }, (_, i) => ({
      day: table.getCell(i, day),
      people: Number(table.getCellRaw(i, people)),
    }));
  } finally {
    table.dispose?.();
  }
  signal.throwIfAborted();
  const chart = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = "Show ";
  const select = document.createElement("select");
  for (const n of [7, 14, 28]) select.add(new Option(n + " days", String(n), n === 14, n === 14));
  label.append(select);
  const detail = document.createElement("p");
  detail.textContent =
    reads +
    " range reads · " +
    transferred.toLocaleString("en-US") +
    " of " +
    activity.byteLength.toLocaleString("en-US") +
    " file bytes";
  detail.dataset.bytes = String(transferred);
  el.append(label, chart, detail);
  const draw = () => {
    const days = rows.slice(0, Number(select.value)).reverse();
    chart.replaceChildren(
      Plot.plot({
        width: Math.max(220, el.clientWidth),
        height: 200,
        marginBottom: 42,
        x: {
          domain: days.map((d) => d.day),
          ticks: days
            .filter((_, i) => i % Math.ceil(days.length / Math.max(2, el.clientWidth / 65)) === 0)
            .map((d) => d.day),
          label: null,
        },
        y: { grid: true, label: "Active people" },
        marks: [
          Plot.barY(days, {
            x: "day",
            y: "people",
            fill: "var(--primary)",
            title: (d) => d.day + " · " + d.people,
          }),
        ],
      }),
    );
  };
  select.addEventListener("change", draw, { signal });
  const observer = new ResizeObserver(draw);
  observer.observe(el);
  draw();
  return () => observer.disconnect();
}
