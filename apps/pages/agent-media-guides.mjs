import { ANYWIDGET_MEDIA_TYPE, OUTPUT_ASSET_TYPES } from "./shared/anywidget-view.mjs";
import { CHART_MAX_ROWS } from "./shared/chart-spec.mjs";
import { VIEW_SPEC_MAX_BYTES } from "./shared/view-spec.mjs";
import { SOURCE_HISTORY_LIMIT } from "./model/sources-doc.mjs";
import { MAX_VIEWS } from "./shared/views.mjs";
import { OUTPUT_STYLE_VARIABLES } from "@nteract/output-frame/context";

// Public, deployment-local documentation. Keep proposed schemas out of these
// guides: examples must pass the validators shipped with the same deployment.
const json = (value) => `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const call = (operation, args) => json({ operation, arguments: args });
const edit = (nonce, operations) =>
  call("edit_page", {
    page_id: "<page_id>",
    revision: "<revision from read or receipt>",
    nonce,
    operations,
  });
const source = (source_id, name) => ({
  op: "set_source",
  source_id,
  name,
  asset_id: "<asset_id from this file's upload>",
  source_revision: null,
});
const place = (view_id, after_node_id = "<id of the block the view follows>") => ({
  op: "insert_node",
  node: { type: "view", attrs: { view_id } },
  after_node_id,
});
const link = (origin, path, title) => `[${title}](${origin}${path})`;

/** Which file format to upload for data, said wherever uploads and view
 * data are described. Each CSV statement is what viewer/csv-arrow.test.mjs
 * checks the conversion returns. */
export const DATA_FORMAT_ADVICE =
  "Prefer Parquet when you can write it: it stores each column's type, so dates, integers, decimals and text arrive exactly as written, and a module view can hand the file to Sift to read only the parts it needs. CSV (text/csv) is accepted for convenience, and its types are inferred when it is read, so check the result: a column of digits such as postal codes becomes numbers and loses its leading zero, the first row is always the header, only commas separate fields, the file must be UTF-8, and a timestamp with no zone is read as UTC. A value that looks like a date or timestamp but is not a real one, such as 2024-02-30, fails the whole file: fix the value, or write Parquet. JSON suits a small nested object, not a table of rows.";

export const MEDIA_GUIDES = Object.freeze([
  {
    path: "/llms/assets-and-sources.txt",
    title: "Assets and sources",
    description: "Upload bytes, name sources, update and pin inputs.",
    body: assetsGuide,
  },
  {
    path: "/llms/views.txt",
    title: "Rendering and views",
    description: "Choose direct rendering or a configured view; place, update and retry it.",
    body: viewsGuide,
  },
  {
    path: "/llms/anywidget.txt",
    title: "Anywidget",
    description: "Executable frontend, CSS, initial state and binary input recipes.",
    body: anywidgetGuide,
  },
  {
    path: "/llms/vega-lite.txt",
    title: "Vega-Lite",
    description: "Chart specifications connected to named Parquet sources.",
    body: vegaGuide,
  },
]);

export function mediaGuideIndex(origin) {
  return MEDIA_GUIDES.map(
    ({ path, title, description }) => `- ${link(origin, path, title)}: ${description}`,
  ).join("\n");
}

export function mediaGuide(path, origin) {
  const guide = MEDIA_GUIDES.find((entry) => entry.path === path);
  if (!guide) return null;
  return `# Pages: ${guide.title}\n\nThese instructions describe the API supported by this deployment. Code examples use the HTTP tool envelope; in MCP, call the named tool with its arguments object. Replace angle-bracket placeholders with returned values. Do not send example placeholders literally.\n\n${guide.body(origin)}\n\n## Related guides\n\n${link(origin, "/llms.txt", "Pages entry point and authentication")}\n\n${mediaGuideIndex(origin)}\n`;
}

function assetsGuide(origin) {
  return `An asset is immutable, content-addressed bytes uploaded to this Page. A source is a Page-scoped name whose revisioned record points to an asset. The host records the asset's media type on the source; set_source does not accept a second media_type. Neither uploading nor naming an asset places anything in the document.

## Upload a file

Create a Page with create_page or read an existing Page with read_page. Keep its page_id and revision. Request an upload capability for each file:
${call("create_page_asset_upload", { page_id: "<page_id>", content_type: "text/javascript", source: { source_id: "counter-module", name: "Counter module" } })}
POST that file's raw bytes to the returned upload_url using the returned headers. Use the returned example command as a template. Do not send multipart or base64, and do not send your account credential to that URL. With source, the transfer also creates the named source and returns source_id and source_revision. Omit source to store bytes alone. A capability expires within ten minutes; request a new one if it expires. Identical bytes reuse the same asset ID.

Supported view input types are ${OUTPUT_ASSET_TYPES.map((type) => `\`${type}\``).join(", ")}. For nested objects, lists and settings, upload UTF-8 JSON with content_type application/json and a source name. Readers can inspect the fields and original JSON in the browser’s Sources pane. For tabular records, upload Parquet, or a CSV with content_type text/csv, whose header and first rows the Sources pane shows. ${DATA_FORMAT_ADVICE} Use application/octet-stream for untyped bytes. The main guide covers image, Parquet and CSV insertion. For a client-attached image, Parquet file or file declared as application/json or text/csv, pass the attachment in file. For JavaScript, CSS, WAV or untyped bytes, request an upload_url with the matching content_type and POST the bytes.

Independent files can request capabilities and upload in parallel. For Parquet or CSV, send the returned insert operation to place a table. A named upload gives you a table that follows the source on refresh. An unnamed upload gives you a table pinned to those bytes. JSON, JavaScript, CSS, WAV and binary upload receipts have insert:null: use sources and a view to display them.

## Refresh an existing source

The named upload above created counter-module. To publish a new version, upload the replacement bytes without a source name and keep their asset_id. Read counter-module to get its current source_revision:
${call("read_page", { page_id: "<page_id>", source_id: "counter-module" })}
If the read returns source.source_revision "1", the update looks like this. Use the revision you actually read.
${edit("refresh-counter-001", [{ ...source("counter-module", "Counter module"), source_revision: "1" }])}
The receipt's result.edits entry gives the new source_revision. A stale_source refusal means another edit won. Read the source again and decide whether to update it. Reuse a nonce for an exact retry and choose a new nonce for a changed request.

## Name bytes you uploaded earlier

If your upload receipt has only an asset_id and the Page still needs a new source, use set_source with the asset_id, a new source_id, a display name and source_revision:null. You can also resubmit the same bytes with source on the upload. Identical bytes reuse the asset. A single edit_page batch can register several sources. Send view and body edits in their own batches.

## Datasets from another Page or Project

To chart a Parquet dataset that is on another Page or a Project, don't download it. Read its asset_id from that Page's or Project's source, then add asset_from with that Page's or Project's id to the set_source on your Page:
${edit("reuse-daily-001", [{ ...source("daily", "Daily usage"), asset_id: "<asset_id read from the other source>", asset_from: "<other Page's or Project's id>" }])}
Pages copies the dataset to your Page under the same asset_id first. You need read access to the other Page or Project. Only Parquet copies.

## Following and pinning

A binding {"source_id":"counter-module"} follows current bytes. Adding "revision":"1" selects that retained source version. History holds the newest ${SOURCE_HISTORY_LIMIT} states: a pin is not a permanent archive. For a dataframe that must name immutable data directly, use its asset_id form.

Images can be inserted directly from an asset. A Parquet or CSV dataframe can use asset_id or a source binding; give a CSV one media_type text/csv. There is no generic render-any-media block or direct WAV player block. For custom combinations, follow ${link(origin, "/llms/views.txt", "Rendering and views")}.
`;
}

function viewsGuide(origin) {
  const example = {
    op: "set_view",
    view_id: "activity",
    title: "Activity",
    view_type: "module",
    module: { source_id: "activity-module" },
    view_revision: null,
  };
  return `For a Parquet or CSV table, use insert_node with type dataframe. For a custom JavaScript chart, control or React component, create a module view. A source names bytes. A view connects an entry module to its inputs. A view node places it on the Page.

## Create a JavaScript view

Upload browser-ready text/javascript with a source ID and name. Give the entry a named render export, or a default AFM export. render receives { model, el, signal, host }: the model, the element to draw in, an AbortSignal that aborts when the view is removed or mounted again, and host, described in Frame environment below. Return a cleanup function if needed. React state and DOM events work inside the frame. Choose view_type anywidget for an existing widget with its own model state, or vega-lite for a declarative chart.

Upload JSON objects or lists with content_type application/json; upload a table as application/vnd.apache.parquet or text/csv. ${DATA_FORMAT_ADVICE} Each name in data is a key on the model, and model.get(name) is a file: ask it with await for .parquet(), .csv(), .json(), .text() or .arrayBuffer(). .csv() gives an array of row objects with a columns list of the names, as Observable's FileAttachment.csv does, typed as a table's values are. A table has numRows, schema.fields, getChild(name).toArray() and toArray(), and Plot takes it directly. Listen for change:<name> to redraw in place; otherwise the view starts again with the new data. Forgetting await passes a promise to Plot, which then draws nothing.

A file also has name, mimeType and size, and nothing is read until the view asks. .parquet() rejects for a file that is not Parquet; .csv() reads a file of any type as CSV and rejects one that does not parse, saying why. A table holds up to 250,000 rows and 256 columns; its values are plain JavaScript: dates and timestamps are Date objects, a missing value is null, decimals are numbers, and a 64-bit integer column is numbers when every value is a safe integer (within ±(2^53 − 1)), otherwise BigInt. .arrayBuffer(), .text() and .json() read the whole file: at most 5 MiB, read once per file, and at most 32 MiB across one view's files. A source that moves to a new version, or to another file type, gives the model a new file and fires change:<name>.

\`\`\`js
import * as Plot from "@observablehq/plot";
export async function render({ model, el }) {
  const table = await model.get("activity").parquet();
  el.append(Plot.barY(table, { x: "day", y: "people" }).plot());
}
\`\`\`

To redraw in place when the data changes, listen for it:

\`\`\`js
import * as Plot from "@observablehq/plot";
export async function render({ model, el }) {
  const draw = async () => {
    const table = await model.get("activity").parquet();
    el.replaceChildren(Plot.barY(table, { x: "day", y: "people" }).plot());
  };
  model.on("change:activity", draw);
  await draw();
}
\`\`\`

For plain rows, read (await model.get("activity").parquet()).toArray(), or await model.get("activity").csv() for a CSV: one object per row, such as { day, people }.

Every save of a view pins the host's current libraries. read_page.libraries lists the exact names available here. Import them directly, as this entry imports @observablehq/plot. The receipt and read_page.view.catalog_revision identify that library build. A view runs on it while this host serves it, and otherwise on the host's current libraries, so every stored view can import the names read_page.libraries lists.

${edit("save-activity", [example])}
Then place it in a second request:
${edit("place-activity", [place("activity")])}

To share a component, upload its JavaScript once. Each view chooses an import name for that source. With the following definition the entry can write \`import { ChoiceGroup } from "activity-controls"\`. Omit revision to follow the source, or give a retained revision to pin it.

${edit("save-shared-control", [{ ...example, view_revision: "1", imports: { "activity-controls": { source_id: "controls" } }, data: { activity: { source_id: "project-activity" } } }])}

A view's modules can import the names in read_page.libraries, a name bound in imports, data/<alias> for a file bound in data, or an https: URL. Names match exactly, so a subpath such as d3/array and any relative path fail. set_view reads the entry and each import and refuses the view with invalid_view when a static import can't load, naming each one. An import("…") that can't load, a module it can't parse, or a module it couldn't read is saved with a warning in the receipt. A set_source that gives a followed module new code warns for each view it breaks among the views the host has open; save a view again with set_view to check it.

## Match the Page appearance

Pages sends its selected light or dark theme into the frame and updates the CSS variables when the reader switches. Let labels and axes inherit currentColor. Pair surfaces with their text color, including hover details. A custom tooltip can use these frame tokens.

\`\`\`css
.chart-tip {
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
}
\`\`\`

Observable Plot uses --plot-background behind its tips and currentColor for their text. If you give a plot a custom background, pass a CSS string in the plot options, such as \`style: "--plot-background: var(--card); color: var(--card-foreground)"\`. Use the Page's appearance control to try Light and Dark while the chart is open. Hover a point in each mode and read its values. Check axis labels, legend entries and the selected control too.

Before the view first runs, and again on every switch, the frame sets data-theme, a dark or light class and color-scheme on <html>, and sets each token there as a CSS variable. CSS that uses the variables follows the theme with no code. The tokens are ${OUTPUT_STYLE_VARIABLES.join(", ")}. Colors arrive as oklch() strings. There are no chart, success, warning or info colors: a view that needs categorical colors brings its own for both themes.

host.getContext() returns { theme: "light" or "dark", styles: { variables } } with the current token values. host.onContextChange(listener) calls the listener after each switch, once the CSS has changed, and returns an unsubscribe function. A view that draws to canvas or WebGL redraws there. A library that can't parse oklch() needs each color converted first; a one-pixel canvas does it, and gives the comma form every color parser reads:

\`\`\`js
function rgb(color) {
  const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
    .getContext("2d", { willReadFrequently: true });
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return \`rgba(\${r}, \${g}, \${b}, \${a / 255})\`;
}
const primary = rgb(host.getContext().styles.variables["--primary"]);
\`\`\`

## Requests and placement

Each view is its own document, and one edit_page request writes one document, so a batch with set_view holds nothing else: plan one request for each view you create or change. The Page's sources are another document, so set_source and delete_source share a batch only with each other. Body edits such as insert_node, insert_markdown and replace_block_markdown share a third kind of batch.

insert_node puts the view in a block of its own, directly after the block named by after_node_id. Omit after_node_id to append at the end of the Page, or pass null to put the view first. It must be a block's id: a paragraph's or heading's node id is refused with wrong_address_kind. Nothing splits a block, and create_page writes its whole Markdown as one block, so a view lands between two passages only when they are separate blocks.

To build a new Page, create it with only the prose before the first view, and save each view with set_view. Then send one batch that alternates insert_node and insert_markdown with after_node_id omitted. Operations apply in order, and each lands after the one before it at the end of the Page. For two views: insert_node activity, insert_markdown the text between, insert_node retention.

If one block already holds all the prose, split it in one batch: replace_block_markdown that block with the text before the view, then insert_markdown the rest, then insert_node the view. Give both inserts that block's id as after_node_id. Each lands directly after the block, so the view, sent last, goes ahead of the rest. replace_block_markdown resends the prose: copy it exactly from read_page, since anything you leave out is deleted.
${edit("split-intro", [{ op: "replace_block_markdown", node_id: "<the block's id>", markdown: "<the text before the view, exactly as read>" }, { op: "insert_markdown", markdown: "<the rest, exactly as read>", after_node_id: "<the block's id>" }, place("activity", "<the block's id>")])}

## Frame environment

A view runs in a sandboxed frame with an opaque origin.

- Scripts: import libraries by name through read_page.libraries and imports first. Beyond those, a script may come from any https: host, inline or a blob, so a library that ships only as a classic (UMD) bundle can load with a script element. There is no eval: eval and new Function throw. WebAssembly compiles.
- Network: requests may go to any host. A server sees Origin: null and must allow it for a cross-origin read. Images and media load from any host; fonts from https: or data:; stylesheets from https: or inline; workers only from a blob. Nested frames are refused.
- Layout: the frame's base styles set a 14px system font and the Page's background. Buttons and range inputs have min-height: 44px, so a compact control sets its own min-height. html clips vertical overflow, so content drawn below the body, such as a popup past the last row, is cut off.
- Height: the frame grows to the body's height by itself, up to 100000 px. Don't set a height on the view or give the whole view an inner scroller.
- Errors: a view that throws while it mounts shows its message to the person looking at the Page, with a Retry button. No tool returns that message to you, and set_view checks only that static imports load. Ask the person to look at the view, or keep the module small and defensive.

## Read part of a file

For a large file, read only the bytes you need: \`await model.get("activity").slice(0, 4).arrayBuffer()\` reads those four bytes, and slice(start, end) counts as Blob.slice does. \`import activity from "data/activity"\` gives the same file, bound to the one the view mounted with; after a change its calls fail as aborted, so use model.get("activity") for the current file. Each range uses the Page's existing access checks. Read the Parquet source with read_page and source_id to discover its columns. To show part of a table, filter it in the view, for example table.toArray().slice(0, 28).

## Inspect and edit

Read a view to get its current revision and bindings. Use that revision as view_revision when updating it. Use views:true for a list and the Page outline for placements. A Page supports up to ${MAX_VIEWS} views. Removing a node removes that placement. The view and sources can still be used elsewhere on the Page.

${call("read_page", { page_id: "<page_id>", view_id: "activity" })}

## Updates and recovery

Advancing a followed source updates dependent views without editing their blocks. A data source or anywidget buffer moving to a new version reaches the mounted view as a change event and keeps its local state when the view listens for that change; a view that does not listen is mounted again. A code change remounts the frame and resets temporary model state: the module, an import, a stylesheet, anywidget state or models, or the spec itself. A title change relabels the view in place. Pin individual input revisions when appropriate, subject to retained source history.

Retries of the same edit must preserve both nonce and payload. If creating the view succeeded but placement was interrupted, retry the placement with its original nonce; do not create another view. For an unknown outcome, use the receipt/retry contract rather than guessing success. If a revision is stale, reread and reconcile before issuing a new request.

unknown_source means a binding names a source not registered on this Page. unknown_source_revision means its pin is not retained. invalid_view means the envelope, spec or bindings failed validation, or a module view's static import can't load. stale_view requires a fresh view read. unknown_view on insertion means the referenced view has not been created successfully. Do not solve a refusal by removing revision guards.
`;
}

function anywidgetGuide(origin) {
  const counter = {
    op: "set_view",
    view_id: "counter",
    title: "Local counter",
    view_type: "anywidget",
    spec: { module: { source_id: "counter-module" }, state: { count: 0 } },
    view_revision: null,
  };
  const binary = {
    op: "set_view",
    view_id: "audio",
    title: "Recording",
    view_type: "anywidget",
    spec: {
      module: { source_id: "audio-module" },
      stylesheet: { source_id: "audio-style" },
      state: { audio: {} },
      buffers: [{ source: { source_id: "recording" }, path: ["audio", "bytes"] }],
    },
    view_revision: null,
  };
  return `For new JavaScript views and shared components, start with ${link(origin, "/llms/views.txt", "module views")}. For an existing widget that needs a model, use an [Anywidget Front-End Module](https://anywidget.dev/en/afm/). Pages supplies local model state in an isolated iframe. The Pages envelope is \`${ANYWIDGET_MEDIA_TYPE}\`; it is not a Jupyter widget-view model_id reference.

## A complete counter

Save this as counter.mjs and upload it as text/javascript. Its frontend needs no Pages-specific API:

\`\`\`js
export default {
  render({ model, el, signal }) {
    const button = document.createElement("button");
    const update = () => { button.textContent = "Count: " + model.get("count"); };
    model.on("change:count", update);
    button.addEventListener("click", () => {
      model.set("count", model.get("count") + 1);
      model.save_changes();
    }, { signal });
    update();
    el.append(button);
    return () => { model.off("change:count", update); button.remove(); };
  }
};
\`\`\`

Create or read your Page, upload the module, and register counter-module using ${link(origin, "/llms/assets-and-sources.txt", "the upload and source recipe")}. Then create the view:
${edit("create-counter-001", [counter])}
Place it in a new request, using the latest Page revision:
${edit("place-counter-001", [place("counter")])}
Read back the view and Page outline. In a browser, check that the counter appears and increments. That browser check establishes rendering; successful storage alone does not.

## CSS and binary input

Upload audio.mjs as text/javascript, audio.css as text/css, and a recording as audio/wav. Register audio-module, audio-style and recording with their respective asset IDs (three set_source operations in one batch). This view wires them together:
${edit("create-audio-001", [binary])}
Then place view_id:audio with a separate insert_node, as above. For this example, audio.mjs can be:

\`\`\`js
export default {
  render({ model, el }) {
    const bytes = model.get("audio").bytes; // DataView
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const player = document.createElement("audio");
    player.controls = true;
    player.src = url;
    el.append(player);
    return () => {
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.remove();
      URL.revokeObjectURL(url);
    };
  }
};
\`\`\`

An audio.css file containing \`audio { display: block; width: 100%; }\` is sufficient. module and stylesheet directly reference JavaScript/CSS sources. The host checks source existence, retained revisions and the required media types when saving the view; the renderer checks again when a followed source changes. Each buffers entry pairs a source reference with its destination path, avoiding aliases and parallel arrays. The runtime restores a DataView at that path; intermediate objects and array slots must already exist. Object leaves may be absent. Paths cannot overlap. The outer data field is not accepted for anywidget views.

For a JSON input, upload the file as application/json, register its source, and add {source:{source_id:"dataset"},path:["dataset"]} to buffers. An anywidget reads the buffer with JSON.parse(new TextDecoder().decode(model.get("dataset"))). A module view reads a JSON source with await model.get("dataset").json(). Add revision:"1" to any source reference to select a retained version; omit it to follow updates. Child definitions use the same references and may share modules/styles/data. Identical references share one byte transfer; different pins remain independent.

## State, composition and lifecycle

The default ESM export is an AFM object or async factory. initialize runs before render; returned cleanup functions run on disposal. Both hooks receive lifetime signals. Optional models maps child IDs to the same definition shape; state may reference them as "anywidget:<id>", resolved through host.getWidget or host.getModel. There is no cross-frame model registry.

model.get/set/on/off operate locally. save_changes() is a no-op. send() throws a no-backend error. There are no Python callbacks, kernel comms, shared live widget state, or Page writeback. Code changes and remounts reset to the stored initial state. A followed buffer source moving to a new version sets the model key that holds its path, and change:<key> fires. Listen with model.on("change:<key>", …) to update in place and keep local state; a widget that does not listen for any key the buffer fills is mounted again. The host supplies the resolved light/dark theme, base controls and height reporting. Use the paired CSS colors and hover check in ${link(origin, "/llms/views.txt", "Match the Page appearance")}.

Bundle relative imports, or use absolute HTTPS imports; Blob modules cannot resolve relative file imports. set_view saves a widget whose import can't load, with a warning in the receipt. The iframe receives supplied bytes, not account credentials. Modules can access the network and transmit those bytes; isolation protects the surrounding application, not confidentiality from the module itself. Microphone capture is not currently exposed.

For pinning, updating and retrying, see ${link(origin, "/llms/views.txt", "Rendering and views")}.
`;
}

function vegaGuide(origin) {
  const view = {
    op: "set_view",
    view_id: "daily-chart",
    title: "Daily usage",
    view_type: "vega-lite",
    spec: {
      data: { name: "usage" },
      mark: "bar",
      encoding: {
        x: { field: "day", type: "temporal" },
        y: { field: "count", type: "quantitative" },
      },
    },
    data: { usage: { source_id: "daily" } },
    view_revision: null,
  };
  return `Pages renders a validated, static subset of Vega-Lite. Upload a Parquet file with day and count columns and register it as source daily using ${link(origin, "/llms/assets-and-sources.txt", "Assets and sources")}. A chart's dataset may be a Parquet or a CSV source. The chart specification stays in the view; the dataset stays in its source.

## Create and place a chart
${edit("create-daily-chart-001", [view])}
After creation succeeds, use the latest Page revision in a separate request:
${edit("place-daily-chart-001", [place("daily-chart")])}
The spec's data.name is a chart-local name; the outer data map binds it to a Page source. Here usage and daily are deliberately different. Match every name read by spec exactly, with no missing or extra bindings. A source can feed multiple charts or a dataframe with different presentations.

## Supported behavior

Data references must be named datasets: {"name":"usage"}. Inline values and URL data loading are not supported by this adapter. Charts support approved marks, field types, transforms and hover tooltips; interactive selections, bindings and raw signals are refused. The full Vega-Lite language is not accepted. A refusal describes the unsupported part; simplify the spec rather than moving external fetches into it.

A spec is limited to ${VIEW_SPEC_MAX_BYTES / 1024} KiB and each dataset to ${CHART_MAX_ROWS.toLocaleString("en-US")} input rows. The same spec checks run at admission and rendering. Data-dependent errors can still appear only when drawing, so verify in a browser after reading back the saved view.

To refresh data, upload a replacement Parquet file and update source daily with its observed source_revision. The chart follows without a view edit. To change the chart configuration, read view_id:daily-chart and send the complete set_view using its revision as view_revision. Bind {source_id, revision} to pin a retained source version; history retention still applies.

See ${link(origin, "/llms/views.txt", "Rendering and views")} for identity, placement, batching and error recovery.
`;
}
