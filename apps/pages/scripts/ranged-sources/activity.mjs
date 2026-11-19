import * as Plot from "@observablehq/plot";

// Daily active people in the archive's first project. `activity` is the bound
// Parquet file; `parquet()` gives it as an Arrow-style table whose first 28
// rows are that project's latest 28 days.
export async function render({ model, el, signal }) {
  const chart = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = "Show ";
  const select = document.createElement("select");
  for (const n of [7, 14, 28]) select.add(new Option(n + " days", String(n), n === 14, n === 14));
  label.append(select);
  const detail = document.createElement("p");
  el.append(label, chart, detail);
  let rows = [];
  const read = async () => {
    const table = await model.get("activity").parquet();
    const project = table.getChild("project_id").toArray();
    const day = table.getChild("day").toArray();
    const people = table.getChild("active_people").toArray();
    rows = [];
    for (let i = 0; i < table.numRows && project[i] === project[0]; i++)
      rows.push({ day: day[i], people: people[i] });
    detail.textContent = table.numRows.toLocaleString("en-US") + " rows in the archive";
    detail.dataset.rows = String(table.numRows);
  };
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
  model.on("change:activity", async () => {
    await read();
    draw();
  });
  select.addEventListener("change", draw, { signal });
  const observer = new ResizeObserver(draw);
  observer.observe(el);
  await read();
  draw();
  return () => observer.disconnect();
}
