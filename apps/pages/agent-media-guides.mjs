import {
  ANYWIDGET_MEDIA_TYPE,
  MODULE_MEDIA_TYPE,
  OUTPUT_ASSET_TYPES,
} from "./shared/anywidget-view.mjs";
import { CHART_MAX_ROWS } from "./shared/chart-spec.mjs";
import { VIEW_SPEC_MAX_BYTES } from "./shared/view-spec.mjs";
import { SOURCE_HISTORY_LIMIT } from "./model/sources-doc.mjs";
import { MAX_VIEWS, VIEW_MEDIA_TYPES } from "./shared/views.mjs";

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

export function mediaGuide(path, origin, frameUrl) {
  const guide = MEDIA_GUIDES.find((entry) => entry.path === path);
  if (!guide) return null;
  return `# Pages: ${guide.title}\n\nThese instructions describe the API supported by this deployment. Code examples use the HTTP tool envelope; in MCP, call the named tool with its arguments object. Replace angle-bracket placeholders with returned values. Do not send example placeholders literally.\n\n${guide.body(origin, frameUrl)}\n\n## Related guides\n\n${link(origin, "/llms.txt", "Pages entry point and authentication")}\n\n${mediaGuideIndex(origin)}\n`;
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

function viewsGuide(origin) {
  return `Use a direct asset block when it already provides the presentation you need: insert_image for an image, or insert_node with type:dataframe for Parquet. A dataframe can also follow or pin a source. You do not need a separate view record for those cases.

A view has its own identity, title, configuration and source bindings. A document block refers to that view by view_id. Use a view for a chart or an executable anywidget frontend. A view's media_type identifies its configuration format, while its inputs retain their own asset media types.

## Choose a view format

${VIEW_MEDIA_TYPES.map((type) => `- \`${type}\``).join("\n")}

The spec field contains configuration for the selected type. For Vega-Lite, data maps the named datasets to {source_id} or {source_id, revision}. Anywidget instead carries direct source references in spec.module, spec.stylesheet and each spec.buffers entry; omit data. See ${link(origin, "/llms/anywidget.txt", "Anywidget examples")} or ${link(origin, "/llms/vega-lite.txt", "Vega-Lite examples")} for complete set_view operations. Do not place source text or URLs where a source reference is expected.

## Module views and ranged files

A plain JavaScript entry exports render({el, signal}) and can return a cleanup function. Use this spec with media_type \`${MODULE_MEDIA_TYPE}\`:

{"module":{"source_id":"activity-chart","revision":"1"},"files":{"activity":{"source_id":"project-activity","revision":"1"}}}

In the entry, \`import activity from "data/activity"\` returns a ByteSource scoped to this view. Its byteLength is the size in bytes. Its read(offset, length, signal) resolves to exactly that span as a Uint8Array. Each source can follow its current revision or specify a retained revision. Read the Parquet source with read_page and source_id to discover its columns. On the local standard catalog, import loadTableFile from the named exports of @nteract/sift/parquet. Use await loadTableFile(activity, {maxRows:28, overflow:"truncate"}) for a bounded leading preview and call table.dispose() when done. The host authorizes each range. Omitting a file binding leaves its alias unavailable to the view.

## Create, place, and inspect

1. Upload the required files and register their sources using ${link(origin, "/llms/assets-and-sources.txt", "Assets and sources")}.
2. Choose a Page-scoped view_id. Send set_view alone in an edit_page batch, with explicit view_revision:null to create it. An existing ID refuses creation; choose another ID or read its revision before updating.
3. After that succeeds, place its block in a separate edit_page call:
${edit("place-counter-001", [place("counter")])}
Omitting after_node_id appends. null prepends; a node ID places it after that block. The author already knows the view_id. The calls are separate because each journaled batch currently writes one document: the view and body live in different documents.
${call("read_page", { page_id: "<page_id>", view_id: "counter" })}
Read views:true to list views (Vega-Lite includes data; anywidget includes dependencies with source, role and location); read the Page outline to locate its view blocks. A single-view read includes spec and revision; pass that revision as view_revision on the next complete set_view. A Page supports up to ${MAX_VIEWS} views. Removing a block with delete_node removes the placement, not the reusable view or sources.

## Updates and recovery

Advancing a followed source updates dependent views without editing their blocks. Anywidget code or input changes remount the frame and reset temporary model state. Pin individual input revisions when appropriate, subject to retained source history.

Retries of the same edit must preserve both nonce and payload. If creating the view succeeded but placement was interrupted, retry the placement with its original nonce; do not create another view. For an unknown outcome, use the receipt/retry contract rather than guessing success. If a revision is stale, reread and reconcile before issuing a new request.

unknown_source means a binding names a source not registered on this Page. unknown_source_revision means its pin is not retained. invalid_view means the envelope, spec or bindings failed validation. stale_view requires a fresh view read. unknown_view on insertion means the referenced view has not been created successfully. Do not solve a refusal by removing revision guards.
`;
}

function anywidgetGuide(origin, frameUrl) {
  const local =
    new URL(origin).hostname === "localhost" &&
    frameUrl &&
    URL.canParse(frameUrl) &&
    new URL(frameUrl).hostname === "127.0.0.1";
  const catalog = local
    ? `

## Local widget imports

Read widget_imports on read_page to see the active catalog, import names, Page modules, and source_revision. Select the local standard catalog in one edit_page operation:

{"op":"set_widget_imports","catalog":"standard","source_revision":null}

For a shared component, upload browser-ready text/javascript and set_source as usual. Declare its import name and exact source revision in the same catalog operation:

{"op":"set_widget_imports","catalog":"standard","source_revision":null,"modules":[{"name":"activity-controls","source_id":"controls","revision":"1"}]}

Use null for the first declaration. To replace it, pass the widget_imports.source_revision you read and the complete list of modules. Selecting standard captures the local catalog build. Each widget frame installs its own import map before loading widget code. New revisions of a component take effect only when you update the declaration. Module names cannot shadow the catalog. Theme tokens and native button styles are available in the frame.

\`\`\`js
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Plot from "@observablehq/plot";
import { ChoiceGroup } from "activity-controls";
\`\`\`

Compile JSX before uploading, or use createElement.
`
    : "";
  const counter = {
    op: "set_view",
    view_id: "counter",
    title: "Local counter",
    media_type: ANYWIDGET_MEDIA_TYPE,
    spec: { module: { source_id: "counter-module" }, state: { count: 0 } },
    view_revision: null,
  };
  const binary = {
    op: "set_view",
    view_id: "audio",
    title: "Recording",
    media_type: ANYWIDGET_MEDIA_TYPE,
    spec: {
      module: { source_id: "audio-module" },
      stylesheet: { source_id: "audio-style" },
      state: { audio: {} },
      buffers: [{ source: { source_id: "recording" }, path: ["audio", "bytes"] }],
    },
    view_revision: null,
  };
  return `Author an [Anywidget Front-End Module](https://anywidget.dev/en/afm/). Pages supplies local model state in an isolated iframe. The Pages envelope is \`${ANYWIDGET_MEDIA_TYPE}\`; it is not a Jupyter widget-view model_id reference.${catalog}

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

model.get/set/on/off operate locally. save_changes() is a no-op. send() throws a no-backend error. There are no Python callbacks, kernel comms, shared live widget state, or Page writeback. Source/code changes and remounts reset to the stored initial state. The resolved light/dark theme, base controls and height reporting are supplied by the host.

Bundle relative imports, or use absolute HTTPS imports; Blob modules cannot resolve relative file imports. The iframe receives supplied bytes, not account credentials. Modules can access the network and transmit those bytes; isolation protects the surrounding application, not confidentiality from the module itself. Microphone capture is not currently exposed.

For pinning, updating and retrying, see ${link(origin, "/llms/views.txt", "Rendering and views")}.
`;
}

function vegaGuide(origin) {
  const view = {
    op: "set_view",
    view_id: "daily-chart",
    title: "Daily usage",
    media_type: "application/vnd.vegalite.v6+json",
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
