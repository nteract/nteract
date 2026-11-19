import { ANYWIDGET_MEDIA_TYPE, OUTPUT_ASSET_TYPES } from "./shared/anywidget-view.mjs";
import { CHART_MAX_ROWS } from "./shared/chart-spec.mjs";
import { VIEW_SPEC_MAX_BYTES } from "./shared/view-spec.mjs";
import { SOURCE_HISTORY_LIMIT } from "./model/sources-doc.mjs";
import { MAX_VIEWS } from "./shared/views.mjs";

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
const place = (view_id) => ({ op: "insert_node", node: { type: "view", attrs: { view_id } } });
const link = (origin, path, title) => `[${title}](${origin}${path})`;

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

export function mediaGuide(path, origin, { catalogEnabled = false } = {}) {
  const guide = MEDIA_GUIDES.find((entry) => entry.path === path);
  if (!guide) return null;
  return `# Pages: ${guide.title}\n\nThese instructions describe the API supported by this deployment. Code examples use the HTTP tool envelope; in MCP, call the named tool with its arguments object. Replace angle-bracket placeholders with returned values. Do not send example placeholders literally.\n\n${guide.body(origin, catalogEnabled)}\n\n## Related guides\n\n${link(origin, "/llms.txt", "Pages entry point and authentication")}\n\n${mediaGuideIndex(origin)}\n`;
}

function assetsGuide(origin) {
  return `An asset is immutable, content-addressed bytes uploaded to this Page. A source is a Page-scoped name whose revisioned record points to an asset. The host records the asset's media type on the source; set_source does not accept a second media_type. Neither uploading nor naming an asset places anything in the document.

## Upload a file

Create a Page with create_page or read an existing Page with read_page. Keep its page_id and revision. Request an upload capability for each file:
${call("create_page_asset_upload", { page_id: "<page_id>", content_type: "text/javascript" })}
POST that file's raw bytes to the returned upload_url using the returned headers. Use the returned example command as a template. Do not send multipart or base64, and do not send your account credential to that URL. Keep the upload response's asset_id. A capability expires within ten minutes; request a new one if it expires. Identical bytes reuse the same asset ID.

Widget input types are ${OUTPUT_ASSET_TYPES.map((type) => `\`${type}\``).join(", ")}. Select the matching content_type for JavaScript, CSS and WAV. For arbitrary bytes, including a JSON file supplied as a widget buffer, use application/octet-stream. Images and Parquet also have upload support; the main guide covers their upload and insertion recipes. A client-attached file can use the upload tool's file argument instead of POST; never invent a client file descriptor.

Independent files can request capabilities and upload in parallel. Register sources only after their uploads succeed. JavaScript, CSS, WAV and binary upload receipts have insert:null: use sources and a view to display them.

## Register and update sources

Source IDs are chosen by the author and scoped to this Page. Explicit source_revision:null creates only; omission is currently invalid. If the ID exists, read it before deciding whether to update or choose a different ID.
${edit("register-counter-001", [source("counter-module", "Counter module")])}
Multiple set_source operations may share one batch; source operations cannot mix with view or body edits. Each result.edits entry returns source_id and source_revision. A source starts at revision "1". Preserve the latest Page revision from reads/receipts for later body edits.
${call("read_page", { page_id: "<page_id>", source_id: "counter-module" })}
To update, upload new bytes, then send set_source with the same source_id, the new asset_id, and the source_revision just read. Keep the intended name too. A stale_source refusal means reread and reconcile; never bypass the revision check. An exact retry uses the same nonce and payload. A changed request uses a new nonce.

## Datasets from another Page or Project

To chart a Parquet dataset that is on another Page or a Project, don't download it. Read its asset_id from that Page's or Project's source, then add asset_from with that Page's or Project's id to the set_source on your Page:
${edit("reuse-daily-001", [{ ...source("daily", "Daily usage"), asset_id: "<asset_id read from the other source>", asset_from: "<other Page's or Project's id>" }])}
Pages copies the dataset to your Page under the same asset_id first. You need read access to the other Page or Project. Only Parquet copies.

## Following and pinning

A binding {"source_id":"counter-module"} follows current bytes. Adding "revision":"1" selects that retained source version. History holds the newest ${SOURCE_HISTORY_LIMIT} states: a pin is not a permanent archive. For a dataframe that must name immutable data directly, use its asset_id form.

Images can be inserted directly from an asset. A Parquet dataframe can use asset_id or a source binding. There is no generic render-any-media block or direct WAV player block. For custom combinations, follow ${link(origin, "/llms/views.txt", "Rendering and views")}.
`;
}

function viewsGuide(origin, catalogEnabled) {
  const example = {
    op: "set_view",
    view_id: "activity",
    title: "Activity",
    view_type: "module",
    module: { source_id: "activity-module" },
    view_revision: null,
  };
  return `For a Parquet table, use insert_node with type dataframe. For a custom JavaScript chart, control or React component, create a module view. A source names bytes. A view connects an entry module to its inputs. A view node places it on the Page.

## Create a JavaScript view

Upload browser-ready text/javascript, then register its asset with set_source. Give the entry a named render export, or a default AFM export. Pages supplies a model, the DOM element and an AbortSignal; return a cleanup function if needed. React state and DOM events work inside the frame. Choose view_type anywidget for an existing widget with its own model state, or vega-lite for a declarative chart.

Each name in data is a key on the model. A Parquet source arrives as a file handle with byteLength and read(offset, length, signal). Any other source arrives as a DataView of the whole file. When a followed source moves to a new version, the view stays mounted: the model takes the new value and change:<name> fires.

\`\`\`js
export function render({ model, el, signal }) {
  const note = el.appendChild(document.createElement("p"));
  const show = async () => {
    const activity = model.get("activity");
    const head = await activity.read(0, 4, signal);
    note.textContent = new TextDecoder().decode(head) + ", " + activity.byteLength + " bytes";
  };
  model.on("change:activity", show);
  return show();
}
\`\`\`

${
  catalogEnabled
    ? `The host pins the standard libraries when you save a new view. read_page.libraries lists the exact names available here. Import them directly. For example:

\`\`\`js
import * as Plot from "@observablehq/plot";
export function render({ el }) {
  el.append(Plot.plot({ marks: [Plot.barY([{ day: "Mon", count: 4 }], { x: "day", y: "count", title: d => d.day + ": " + d.count })] }));
}
\`\`\`

The receipt and read_page.view.catalog_revision identify the pinned library build.`
    : "Use a self-contained entry or bind Page-owned JavaScript sources in imports."
}

${edit("save-activity", [example])}
${edit("place-activity", [place("activity")])}

To share a component, upload its JavaScript once. Each view chooses an import name for that source. With the following definition the entry can write \`import { ChoiceGroup } from "activity-controls"\`. Omit revision to follow the source, or give a retained revision to pin it.

${edit("save-shared-control", [{ ...example, view_revision: "1", imports: { "activity-controls": { source_id: "controls" } }, data: { activity: { source_id: "project-activity" } } }])}

A view's modules can import${catalogEnabled ? " the names in read_page.libraries," : ""} a name bound in imports, data/<alias> for a file bound in data, or an https: URL.${catalogEnabled ? "" : " This host offers no libraries."} Names match exactly, so a subpath such as d3/array and any relative path fail. set_view reads the entry and each import and refuses the view with invalid_view when a static import can't load, naming each one. An import("…") that can't load, a module it can't parse, or a module it couldn't read is saved with a warning in the receipt. A set_source that gives a followed module new code warns for each view it breaks among the views the host has open; save a view again with set_view to check it.

## Read part of a file

model.get(name) is the way to read a bound file. The lower-level path is \`import activity from "data/activity"\` when data binds the name activity. That import names the file the view was mounted with; after a change its reads fail as aborted, so use model.get("activity") for the current file. Its byteLength is the file size. read(offset, length, signal) returns that span as a Uint8Array. Read the Parquet source with read_page and source_id to discover its columns.${catalogEnabled ? " For a bounded preview, import {loadTableFile} from '@nteract/sift/parquet', call await loadTableFile(model.get(\"activity\"), {maxRows:28, overflow:'truncate'}), and call table.dispose() when done." : ""} Each range uses the Page's existing access checks.

## Inspect and edit

Read a view to get its current revision and bindings. Use that revision as view_revision when updating it. Use views:true for a list and the Page outline for placements. A Page supports up to ${MAX_VIEWS} views. Removing a node removes that placement. The view and sources can still be used elsewhere on the Page.

${call("read_page", { page_id: "<page_id>", view_id: "activity" })}

## Updates and recovery

Advancing a followed source updates dependent views without editing their blocks. A data source or anywidget buffer moving to a new version reaches the mounted view as a change event and keeps its local state. A code change remounts the frame and resets temporary model state: the module, an import, a stylesheet, anywidget state or models, or the spec itself. A title change relabels the view in place. Pin individual input revisions when appropriate, subject to retained source history.

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

For an unused dataset input, upload bytes as application/octet-stream, register its source, and add {source:{source_id:"dataset"},path:["dataset"]} to buffers. The module can read model.get("dataset") without using it to render. JSON bytes are not automatically parsed into an object. Add revision:"1" to any source reference to select a retained version; omit it to follow updates. Child definitions use the same references and may share modules/styles/data. Identical references share one byte transfer; different pins remain independent.

## State, composition and lifecycle

The default ESM export is an AFM object or async factory. initialize runs before render; returned cleanup functions run on disposal. Both hooks receive lifetime signals. Optional models maps child IDs to the same definition shape; state may reference them as "anywidget:<id>", resolved through host.getWidget or host.getModel. There is no cross-frame model registry.

model.get/set/on/off operate locally. save_changes() is a no-op. send() throws a no-backend error. There are no Python callbacks, kernel comms, shared live widget state, or Page writeback. Code changes and remounts reset to the stored initial state. A followed buffer source moving to a new version sets the model key that holds its path, and change:<key> fires. The resolved light/dark theme, base controls and height reporting are supplied by the host.

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
  return `Pages renders a validated, static subset of Vega-Lite. Upload a Parquet file with day and count columns and register it as source daily using ${link(origin, "/llms/assets-and-sources.txt", "Assets and sources")}. The chart specification stays in the view; the dataset stays in its source.

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
