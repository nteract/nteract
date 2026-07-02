import { NotebookCellStrip } from "nteract-elements";

// A small inline chart as the output thumbnail - the real dashboard passes the
// notebook's rendered cover blob here.
const chartSvg = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 152 60">` +
    `<polygon fill="rgba(56,189,248,0.18)" points="8,46 34,38 60,42 86,24 112,30 138,12 144,15 144,52 8,52"/>` +
    `<polyline fill="none" stroke="#38bdf8" stroke-width="2" stroke-linejoin="round" points="8,46 34,38 60,42 86,24 112,30 138,12 144,15"/>` +
    `</svg>`,
);
const chartSrc = `data:image/svg+xml,${chartSvg}`;

// Prose lead + closing code line - the shape the dashboard derives from a
// notebook at snapshot publish (first markdown line, last executed line).
export function ProseAndCode() {
  return (
    <div style={{ width: 420 }}>
      <NotebookCellStrip
        preview={[
          { kind: "markdown", text: "## Where activation stalls" },
          {
            kind: "code",
            text: "funnel = df.groupby('step').drop_rate.mean()",
            execution_count: 22,
          },
        ]}
      />
    </div>
  );
}

export function WithThumbnail() {
  return (
    <div style={{ width: 420 }}>
      <NotebookCellStrip
        preview={[
          { kind: "markdown", text: "### Reforecast vs. board plan" },
          { kind: "code", text: "fc = model.forecast(h=13, exog=drivers)", execution_count: 47 },
        ]}
        thumbnail={{ src: chartSrc }}
      />
    </div>
  );
}

// Untrusted source renders as inert text - markup in a cell's first line can
// never become markup in the dashboard.
export function UntrustedSource() {
  return (
    <div style={{ width: 420 }}>
      <NotebookCellStrip
        preview={[
          { kind: "markdown", text: "Escapes `<img onerror=alert(1)>` as plain text" },
          { kind: "code", text: "html = \"<script>alert('never runs')</script>\"" },
        ]}
      />
    </div>
  );
}
