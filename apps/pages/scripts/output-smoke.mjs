// Browser checks of the real frame boundary and Pages' source adapter.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { browserMermaidPlugin } from "./browser-mermaid.mjs";
import { browserSiftPlugin, siftCsvWasmPath, siftWasmPath } from "./browser-sift.mjs";
import { chromium, firefox, webkit, expect } from "@playwright/test";
import { prepareFrameHtml } from "./build-output.mjs";
import { parquetFixture } from "../test/parquet-fixture.mjs";
import { DATAFRAME_LIMITS } from "../viewer/sift-dataset.mjs";
await prepareFrameHtml();
const { default: worker } = await import("../output/worker.mjs");
import { OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { OUTPUT_FRAME_PATH } from "../shared/output-frame-paths.mjs";
import { BOOT_FAILURE } from "@nteract/output-frame/lifecycle";
const configuredFrameUrl = process.env.PAGES_OUTPUT_LIVE
  ? OUTPUT_FRAME_URL
  : `https://selfhosted.widgets.example${OUTPUT_FRAME_PATH}`;
const out = new URL(
  process.env.PAGES_OUTPUT_ARTIFACT
    ? "../test-results/output-real/"
    : "../test-results/output-smoke/",
  import.meta.url,
);
await mkdir(out, { recursive: true });
const pageId = "33333333-3333-4333-8333-333333333333";
const wav = Buffer.alloc(44 + 32000);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 16000; i++)
  wav.writeInt16LE(Math.sin((i * 2 * Math.PI * 261.63) / 8000) * 8000, 44 + i * 2);
const code = `export default {
 async initialize({model}) { if(document.documentElement.dataset.theme!=='light') throw Error('Initial theme was not applied'); await Promise.resolve(); model.set('initialized', true); },
 async render({model,el,host,signal}) {
  if (!model.get('initialized')) throw Error('render preceded initialize');
  if (!(model.get('recording') instanceof DataView)) throw Error('binary contract');
  let domBlocked = false, storageBlocked = false;
  try { parent.document.body; } catch { domBlocked=true; }
  try { localStorage.length; } catch { storageBlocked=true; }
  if (!domBlocked || !storageBlocked || window.__TAURI__) throw Error('isolation failed');
  await host.getModel('unknown').then(() => {throw Error('unexpected composition');}, () => {});
  const url=URL.createObjectURL(new Blob([model.get('recording')],{type:'audio/wav'}));
  el.innerHTML='<h2>Listen and explore</h2><p>Isolated audio with transferred WAV bytes</p><audio controls style="width:100%"></audio><label>Playhead <input type="range" min="0" max="2" step="0.01" value="0"></label><output>0.00</output>';
  el.dataset.theme=host.getContext().theme; host.onContextChange(context=>{el.dataset.theme=context.theme});
  const audio=el.querySelector('audio'); audio.src=url;
  el.querySelector('input').addEventListener('input',e=>{model.set('time',Number(e.target.value));audio.currentTime=model.get('time')},{signal});
  model.on('change:time',()=>{el.querySelector('output').textContent=model.get('time').toFixed(2)});
  model.on('change:recording',()=>{if(model.get('recording') instanceof DataView)el.dataset.recordingChanges=String(Number(el.dataset.recordingChanges??0)+1)});
  return ()=>{audio.pause();URL.revokeObjectURL(url)};
 }
}`;
const tokens = await readFile(
  new URL("../../../src/styles/notebook-tokens.css", import.meta.url),
  "utf8",
);
const baseStyle = await readFile(
  new URL(import.meta.resolve("@nteract/output-frame/styles.css")),
  "utf8",
);
const editorStyle = await readFile(new URL("../viewer/wordgard.css", import.meta.url), "utf8");
const entries = {
  counter: [
    await readFile(new URL("../test/fixtures/anywidget-counter/index.mjs", import.meta.url)),
    "text/javascript",
  ],
  counterstyle: [
    await readFile(new URL("../test/fixtures/anywidget-counter/style.css", import.meta.url)),
    "text/css",
  ],
  composed: [
    Buffer.from(`export default {
    async render({model, el, host, signal}) {
      const child = await host.getWidget(model.get('child'));
      const same = await host.getModel(model.get('child'));
      if (same.get('count') !== 42) throw Error('wrong child model');
      const left=document.createElement('div'), right=document.createElement('div');
      el.append(left, right);
      await child.render({el:left, signal});
      await child.render({el:right, signal});
    }
  }`),
    "text/javascript",
  ],
  layout: [
    Buffer.from(`export default { render({el,signal}) {
    el.innerHTML='<svg viewBox="0 0 600 100" style="display:block;width:100%;height:auto" role="img" aria-label="Responsive chart"><path d="M0,100 L600,0" stroke="currentColor"/></svg><p style="margin:32px 0">Normal-flow margins</p><label>Selection<input type="range" min="0" max="10" value="5"></label><button>Toggle height</button><div id="tall" style="height:1600px;float:left;width:100%">Tall output</div><div class="output-scroll" role="region" aria-label="Wide results" tabindex="0" style="clear:both;max-height:100px"><div style="width:1800px;height:300px">Deliberately scrollable content</div></div><p style="margin:24px 0">Last line</p>';
    el.querySelector('button').addEventListener('click',()=>{const t=el.querySelector('#tall');t.style.height=t.style.height==='1600px'?'40px':'1600px'},{signal});
  } }`),
    "text/javascript",
  ],
  code: [Buffer.from(code), "text/javascript"],
  // The same widget as other code: a change to it remounts the frame.
  code2: [Buffer.from(code + "\n// another build"), "text/javascript"],
  recording: [wav, "audio/wav"],
  // A second recording: moving to it is a data change, not a remount.
  recording2: [Buffer.concat([wav.subarray(0, 44), Buffer.alloc(32000)]), "audio/wav"],
  // A module view that keeps a click count in its DOM and asks its files
  // for text, JSON and a Parquet table.
  modview: [
    Buffer.from(`export async function render({ model, el, signal }) {
  let count = 0;
  el.innerHTML = '<button id="count">0</button><p id="label"></p><p id="config"></p><p id="table"></p>';
  const button = el.querySelector('#count');
  button.addEventListener('click', () => { button.textContent = String(++count); }, { signal });
  const label = async () => { el.querySelector('#label').textContent = await model.get('label').text(); };
  const config = async () => { el.querySelector('#config').textContent = (await model.get('config').json()).greeting; };
  const table = async () => {
    const rows = await model.get('table').parquet();
    el.querySelector('#table').textContent = rows.numRows + ' rows of ' + rows.schema.fields.map((f) => f.name).join(' ');
  };
  model.on('change:label', () => void label());
  model.on('change:config', () => void config());
  model.on('change:table', () => void table());
  await Promise.all([label(), config(), table()]);
}`),
    "text/javascript",
  ],
  // A module view that draws its Parquet table with Plot from
  // await model.get(name).parquet(): an int64 column, a string and a float
  // column with nulls, and a microsecond timestamp. The data/ import is the
  // same file object at mount, and a slice of it reads the file's bytes.
  plotview: [
    Buffer.from(`import * as Plot from 'plot';
import file from 'data/activity';
export async function render({ model, el }) {
  el.innerHTML = '<div id="plot"></div><p id="head"></p>';
  el.dataset.sameFile = String(file === model.get('activity'));
  const draw = async () => {
    const table = await model.get('activity').parquet();
    const plot = Plot.plot({
      marks: [
        Plot.dot(table, { x: 'at', y: 'people' }),
        Plot.lineY(table, { x: 'at', y: 'score' }),
        Plot.text(table, { x: 'at', y: 'people', text: 'name', dy: -8 }),
      ],
    });
    el.querySelector('#plot').replaceChildren(plot);
    el.dataset.xScale = plot.scale('x').type;
    el.dataset.draws = String(Number(el.dataset.draws ?? 0) + 1);
  };
  model.on('change:activity', () => void draw());
  await draw();
  const head = await file.slice(0, 4).text();
  el.querySelector('#head').textContent = head + ' of ' + file.size;
}`),
    "text/javascript",
  ],
  // A module view that draws a CSV source with Plot from
  // await model.get(name).csv(): typed rows with a columns list.
  csvview: [
    Buffer.from(`import * as Plot from 'plot';
export async function render({ model, el }) {
  el.innerHTML = '<div id="plot"></div><p id="rows"></p>';
  const rows = await model.get('cities').csv();
  const plot = Plot.plot({ marks: [Plot.dot(rows, { x: 'founded', y: 'people' })] });
  el.querySelector('#plot').replaceChildren(plot);
  el.dataset.xScale = plot.scale('x').type;
  el.querySelector('#rows').textContent = [
    rows.length, rows.columns.join(' '), rows[0].city, typeof rows[0].people,
    rows[0].founded instanceof Date, rows[1].open, rows[2].people,
  ].join('|');
}`),
    "text/javascript",
  ],
  cities: [
    Buffer.from(
      'city,people,founded,open\n"Oslo, NO",709000,1040-01-01,true\nBergen,291000,1070-01-01,false\nTromsø,,1794-01-01,true\n',
    ),
    "text/csv",
  ],
  // Plot as a Page-owned import, bundled below.
  plotlib: [Buffer.alloc(0), "text/javascript"],
  // A module view that reads its file once through the import and never
  // listens for changes: a data change mounts it again.
  modonce: [
    Buffer.from(`import file from 'data/label';
export async function render({ el }) {
  const text = await file.text();
  el.innerHTML = '<p id="once"></p>';
  el.querySelector('#once').textContent = text;
}`),
    "text/javascript",
  ],
  label1: [Buffer.from("first label"), "application/octet-stream"],
  label2: [Buffer.from("second label"), "application/octet-stream"],
  config1: [Buffer.from('{"greeting":"hello"}'), "application/octet-stream"],
  config2: [Buffer.from('{"greeting":"howdy"}'), "application/octet-stream"],
  table1: [Buffer.from(parquetFixture({ days: 5 })), "application/vnd.apache.parquet"],
  table2: [Buffer.from(parquetFixture({ days: 9 })), "application/vnd.apache.parquet"],
  broken: [
    Buffer.from('export default {initialize(){throw Error("intentional failure")},render(){}}'),
    "text/javascript",
  ],
};
entries.plotlib[0] = Buffer.from(
  (
    await build({
      stdin: { contents: 'export * from "@observablehq/plot";', resolveDir: process.cwd() },
      bundle: true,
      format: "esm",
      minify: true,
      write: false,
    })
  ).outputFiles[0].contents,
);
let description = "Synthetic C4 tone and test heatmap data; browser integration fixture.";
if (process.env.PAGES_OUTPUT_CDN) {
  const { tableFromArrays, tableToIPC } = await import("apache-arrow");
  await import("#sift-wasm");
  const { write_parquet_ipc } = await import("@nteract/sift/wasm");
  let rows = Array.from({ length: 40 * 80 }, (_, i) => ({
    frame: Math.floor(i / 80),
    band: i % 80,
    code: Math.round(7 + 7 * Math.sin(i / 30)),
    time_seconds: Math.floor(i / 80) * 0.05,
  }));
  if (process.env.PAGES_OUTPUT_ARTIFACT) {
    assert.ok(
      process.env.PAGES_OUTPUT_WAV,
      "PAGES_OUTPUT_WAV must identify the original recording",
    );
    const artifact = JSON.parse(await readFile(process.env.PAGES_OUTPUT_ARTIFACT, "utf8"));
    const original = await readFile(process.env.PAGES_OUTPUT_WAV);
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash(original), artifact.source.sha256, "Original WAV provenance");
    assert.equal(
      hash(Buffer.from(artifact.native.q.flat())),
      artifact.native.tensor_sha256,
      "Native tensor provenance",
    );
    entries.recording = [original, "audio/wav"];
    rows = artifact.native.q.flatMap((bands, frame) =>
      bands.map((code, band) => ({
        frame,
        band,
        code,
        time_seconds: artifact.timing.frame_centers_seconds[frame],
      })),
    );
    description = `Original ${artifact.source.task_id} recording and actual native Inkling dMel. WAV and tensor SHA-256 verified.`;
  }
  const table = tableFromArrays(
    Object.fromEntries(
      ["frame", "band", "code", "time_seconds"].map((k) => [k, rows.map((r) => r[k])]),
    ),
  );
  entries.dmel = [
    Buffer.from(write_parquet_ipc(tableToIPC(table))),
    "application/vnd.apache.parquet",
  ];
  entries.example = [
    Buffer.from(await readFile(new URL("../output/audio-example.mjs", import.meta.url))),
    "text/javascript",
  ];
}
const assets = new Map();
const versions = {};
for (const [name, [bytes, media_type]] of Object.entries(entries)) {
  const asset_id = createHash("sha256").update(bytes).digest("hex");
  assets.set(asset_id, { bytes, media_type });
  versions[name] = { asset_id, media_type, revision: "1" };
}
// A module view resolves bare specifiers through the frame's import map: a
// Page import, a bound data/ file and, on the local shell, a catalog entry.
// The local shell's catalog map points at moduleCatalogUrl, served by a route.
const moduleFrameUrl = process.env.PAGES_OUTPUT_LIVE
  ? configuredFrameUrl
  : `${configuredFrameUrl}?catalog=smoke`;
const moduleCatalogUrl = new URL("/catalog/smoke/shout.js", configuredFrameUrl).href;
const moduleEntry = `import { greet } from 'page-greeting';
import file from 'data/sample';
${process.env.PAGES_OUTPUT_LIVE ? "const shout = (s) => s;" : "import { shout } from 'catalog-shout';"}
export async function render({ el, signal }) {
  const bytes = await file.read(6, 5, signal);
  const p = document.createElement('p');
  p.id = 'module-result';
  p.textContent = shout(greet(new TextDecoder().decode(bytes))) + ' of ' + file.byteLength;
  el.append(p);
}`;
const moduleView = {
  entry: moduleEntry,
  greeting: "export const greet = (name) => 'hello ' + name;",
  file: "hello frame bytes",
};
const fixture = `import { BehaviorSubject } from 'rxjs';
import { mountModuleOutput } from '@nteract/output-frame';
import { FRAME_RUNTIME } from './.output-dist/frame-runtime.mjs';
import { Wordgard, Decoration } from 'wordgard/editor';
import { rangeHighlights } from './viewer/range-highlights.mjs';
import { GardState, GardSelection } from 'wordgard/state';
import { Leaf } from 'wordgard/doc';
import { schema, Paragraph, PagesView } from './viewer/wordgard-model.mjs';
import { wordgardViews } from './viewer/wordgard-views.mjs';
import { mount } from './viewer/view-output.mjs';
import { normalizedBytes } from './viewer/normalized-bytes.mjs';
import { themeStore } from './viewer/theme.mjs';
themeStore.setMode(${JSON.stringify(process.env.PAGES_OUTPUT_SERVE ? "system" : "light")});
const appearance=document.querySelector('#appearance');appearance.value=themeStore.getSnapshot().mode;
appearance.addEventListener('change',()=>themeStore.setMode(appearance.value));
const versions=${JSON.stringify(versions)};
const changes=new BehaviorSubject(0);
const view={view_id:'audio',title:'Audio exploration',media_type:'application/vnd.nteract.anywidget.v2+json',spec:{module:{source_id:'code'},buffers:[{source:{source_id:'recording'},path:['recording']}]},revision:'1'};
const view$=new BehaviorSubject({status:'ready',view});
let failNext=false;
const decoded=new Map();
const sources={pageId:'${pageId}',request:(...args)=>{if(failNext){failNext=false;return Promise.resolve(new Response('not yet',{status:503}))}return fetch(...args)},versions:()=>changes,resolve:b=>versions[b.source_id],
  sharedResolver:(decode,{format='parquet'}={})=>({async load(v){
    const limits=${JSON.stringify(DATAFRAME_LIMITS)};
    const key=format+' '+v.asset_id;
    if(!decoded.has(key))decoded.set(key,fetch('/assets/'+v.asset_id).then(r=>r.arrayBuffer()).then(async b=>decode(await normalizedBytes(v,new Uint8Array(b),limits,{asCsv:format==='csv'}),limits)));
    return {table:await decoded.get(key),...v};
  }})};
const handle=mount(document.querySelector('main'),{view$,sources,sourcesAnswer$:null});
let editor; let highlight=null; const permissions=new GardState.Compartment();
window.fixture={editor(){
  handle.destroy();
  window.fixture.counter();
  const node=PagesView.of({view_id:'audio'});
  editor=new Wordgard({parent:document.querySelector('main'),state:GardState.create({
    doc:schema.doc([node,Paragraph.create([Leaf.text('Outside the widget')])]),
    config:[permissions.of([GardState.readOnly.of(false),Wordgard.editable.of(true)]),Decoration.Range.source.of(state=>Decoration.Range.set(highlight?rangeHighlights(state.doc,0,1,highlight):[])),schema.elements.map(e=>GardState.schemaElement.of(e)),wordgardViews({eager:true, sources, views:{hold:()=>({view$,release(){}})}})]
  })});
  window.fixture.highlight=value=>{highlight=value;editor.dispatch({});editor.flush()};
  window.fixture.focus=()=>editor.focus();
  window.fixture.readonly=value=>{editor.dispatch({effects:permissions.reconfigure([GardState.readOnly.of(value),Wordgard.editable.of(!value)])});editor.flush()};
  window.fixture.select=selected=>{editor.dispatch({selection:selected?GardSelection.node(0,node):GardSelection.cursor(2)});editor.flush()};
},unavailable(){view$.next({status:'ready',view:{...view,spec:{}}})},counter(composed=false){
  view$.next({status:'ready',view:{...view,
    spec:composed ? {module:{source_id:'composed'},state:{child:'anywidget:counter'},models:{counter:{module:{source_id:'counter'},stylesheet:{source_id:'counterstyle'},state:{count:42}}}} : {module:{source_id:'counter'},stylesheet:{source_id:'counterstyle'},state:{count:42}}
  }});
},audio(){view$.next({status:'ready',view})},layout(){versions.code=versions.layout;changes.next(4)},transient(){failNext=true;versions.code=versions.code2;changes.next(3)},moduleView(){
  const el=document.createElement('div');el.id='module-view2';document.body.append(el);
  versions.label=versions.label1;versions.config=versions.config1;versions.table=versions.table1;
  const moduleView$=new BehaviorSubject({status:'ready',view:{view_id:'chart',title:'Module data',media_type:'application/vnd.nteract.module-view.v1+json',spec:{module:{source_id:'modview'},files:{label:{source_id:'label'},config:{source_id:'config'},table:{source_id:'table'}}},revision:'1'}});
  const moduleHandle=mount(el,{view$:moduleView$,sources,sourcesAnswer$:null});
  window.fixture.moveData=()=>{versions.label=versions.label2;versions.config=versions.config2;versions.table=versions.table2;changes.next(5)};
  window.fixture.endModuleView=()=>{moduleHandle.destroy();el.remove()};
},onceView(){
  const el=document.createElement('div');el.id='module-view3';document.body.append(el);
  versions.label=versions.label1;
  const onceView$=new BehaviorSubject({status:'ready',view:{view_id:'once',title:'Read once',media_type:'application/vnd.nteract.module-view.v1+json',spec:{module:{source_id:'modonce'},files:{label:{source_id:'label'}}},revision:'1'}});
  const onceHandle=mount(el,{view$:onceView$,sources,sourcesAnswer$:null});
  window.fixture.moveOnce=()=>{versions.label=versions.label2;changes.next(6)};
  window.fixture.endOnceView=()=>{onceHandle.destroy();el.remove()};
},plotView(){
  const el=document.createElement('div');el.id='module-view4';document.body.append(el);
  versions.activity=versions.table1;
  const plotView$=new BehaviorSubject({status:'ready',view:{view_id:'plot',title:'Plot from a table',media_type:'application/vnd.nteract.module-view.v1+json',spec:{module:{source_id:'plotview'},imports:{plot:{source_id:'plotlib'}},files:{activity:{source_id:'activity'}}},revision:'1'}});
  const plotHandle=mount(el,{view$:plotView$,sources,sourcesAnswer$:null});
  window.fixture.movePlot=()=>{versions.activity=versions.table2;changes.next(7)};
  window.fixture.endPlotView=()=>{plotHandle.destroy();el.remove()};
},csvView(){
  const el=document.createElement('div');el.id='module-view5';document.body.append(el);
  const csvView$=new BehaviorSubject({status:'ready',view:{view_id:'csv',title:'Plot from a CSV',media_type:'application/vnd.nteract.module-view.v1+json',spec:{module:{source_id:'csvview'},imports:{plot:{source_id:'plotlib'}},files:{cities:{source_id:'cities'}}},revision:'1'}});
  const csvHandle=mount(el,{view$:csvView$,sources,sourcesAnswer$:null});
  window.fixture.endCsvView=()=>{csvHandle.destroy();el.remove()};
},example(){versions.code=versions.example;view$.next({status:'ready',view:{...view,spec:{module:{source_id:'code'},buffers:[{source:{source_id:'recording'},path:['recording']},{source:{source_id:'dmel'},path:['dmel']}],state:{description:${JSON.stringify(description)}}}}})},module(){
  const view=${JSON.stringify(moduleView)};
  const text=s=>new TextEncoder().encode(s);
  const file=text(view.file);
  const el=document.createElement('div');el.id='module-view';document.body.append(el);
  const output=mountModuleOutput(el,{kind:'module',title:'Module view',assets:{entry:{bytes:text(view.entry),mediaType:'text/javascript'}},imports:{'page-greeting':{bytes:text(view.greeting),mediaType:'text/javascript'}}},{
    frameUrl:${JSON.stringify(moduleFrameUrl)},runtime:FRAME_RUNTIME,hostContext:{theme:'light'},
    files:{'data/sample':{mimeType:'text/plain',byteLength:file.byteLength,read:async(offset,length)=>file.slice(offset,offset+length),bytes:async()=>file.slice()}},
    onState:(state,error)=>{el.dataset.outputState=state;if(error)el.dataset.error=error},
  });
  window.fixture.endModule=()=>{output.destroy();el.remove()};
},bootFailure(){
  const el=document.createElement('div');el.id='boot-failure';document.body.append(el);
  const output=mountModuleOutput(el,{kind:'module',assets:{entry:{bytes:new TextEncoder().encode('export function render() {}'),mediaType:'text/javascript'}}},{
    frameUrl:${JSON.stringify(configuredFrameUrl)},runtime:'throw Error("a runtime that does not start")',hostContext:{theme:'light'},
    timeoutMs:60000,bootTimeoutMs:60000,
    onState:(state,error)=>{el.dataset.outputState=state;if(error)el.dataset.error=error},
  });
  window.fixture.endBootFailure=()=>{output.destroy();el.remove()};
},change(){versions.recording=versions.recording2;changes.next(1)},fail(){versions.code=versions.broken;changes.next(2)},destroy:()=>handle.destroy()};
${process.env.PAGES_OUTPUT_SERVE ? "window.fixture.example();" : ""}`;
const result = await build({
  stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: "output-fixture.mjs" },
  plugins: [browserSiftPlugin(process.cwd()), browserMermaidPlugin(process.cwd())],
  bundle: true,
  format: "esm",
  write: false,
});
const siftWasm = await readFile(siftWasmPath(process.cwd()));
const siftCsvWasm = await readFile(siftCsvWasmPath(process.cwd()));
const server = createServer((req, res) => {
  if (req.url === "/styles.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(baseStyle + "\n" + tokens + "\n" + editorStyle);
    return;
  }
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(result.outputFiles[0].text);
    return;
  }
  if (req.url === "/sift.wasm" || req.url === "/sift-csv.wasm") {
    res.setHeader("Content-Type", "application/wasm");
    res.end(req.url === "/sift.wasm" ? siftWasm : siftCsvWasm);
    return;
  }
  const asset = assets.get(req.url.split("/").at(-1));
  if (asset) {
    // As the Page asset route serves them: a Parquet file as its own type.
    res.setHeader(
      "Content-Type",
      asset.media_type === "application/vnd.apache.parquet"
        ? asset.media_type
        : "application/octet-stream",
    );
    res.setHeader("X-Pages-Media-Type", asset.media_type);
    // Ranged reads, as the Page asset route serves a Parquet file.
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${asset.bytes.length}`);
      res.setHeader("Content-Length", end - start + 1);
      res.end(asset.bytes.subarray(start, end + 1));
      return;
    }
    res.setHeader("Content-Length", asset.bytes.length);
    res.end(req.method === "HEAD" ? undefined : asset.bytes);
    return;
  }
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src ${new URL(configuredFrameUrl).origin}`,
  );
  res.end(
    `<!doctype html><meta name="pages-output-frame-url" content="${configuredFrameUrl}"><meta name="viewport" content="width=device-width"><title>Audio exploration</title><link rel="stylesheet" href="/styles.css"><label style="max-width:900px;margin:20px auto">Appearance <select id="appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><main style="max-width:900px;margin:30px auto;font:16px system-ui"></main><script type="module" src="/app.js"></script>`,
  );
});
await new Promise((resolve) =>
  server.listen(Number(process.env.PAGES_OUTPUT_PORT ?? 0), "127.0.0.1", resolve),
);
if (process.env.PAGES_OUTPUT_SERVE) {
  console.log(`Demo: http://127.0.0.1:${server.address().port}`);
  await new Promise((resolve) => process.once("SIGINT", resolve));
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
const engines = { chromium, firefox, webkit };
const engine = process.env.PAGES_OUTPUT_BROWSER || "chromium";
assert.ok(
  Object.hasOwn(engines, engine),
  `PAGES_OUTPUT_BROWSER must be one of chromium, firefox or webkit`,
);
const browser = await engines[engine].launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, hasTouch: true });
  await page.emulateMedia({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (!process.env.PAGES_OUTPUT_LIVE)
    await page.route(configuredFrameUrl, async (route) => {
      const response = await worker.fetch(new Request(configuredFrameUrl));
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
  if (!process.env.PAGES_OUTPUT_LIVE) {
    // The local shell with a catalog map in its head, the way the widget
    // catalog server embeds one, and the one catalog module that map names.
    await page.route(
      (url) => url.href === moduleFrameUrl,
      async (route) => {
        const response = await worker.fetch(new Request(configuredFrameUrl));
        const map = { imports: { "catalog-shout": moduleCatalogUrl } };
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: (await response.text()).replace(
            "</head>",
            `<script type="application/json" id="widget-catalog-map">${JSON.stringify(map)}</script></head>`,
          ),
        });
      },
    );
    await page.route(moduleCatalogUrl, (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" },
        body: "export const shout = (s) => s.toUpperCase();",
      }),
    );
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  // A module view's entry imports a Page import, a data/ file and a catalog
  // module by bare name. All three resolve through the import map the frame
  // runtime appends at mount.
  await page.evaluate(() => window.fixture.module());
  const moduleHost = page.locator("#module-view");
  await expect
    .poll(async () => moduleHost.evaluate((el) => el.dataset.error ?? el.dataset.outputState))
    .toBe("ready");
  await expect(page.frameLocator("#module-view iframe").locator("#module-result")).toHaveText(
    process.env.PAGES_OUTPUT_LIVE ? "hello frame of 17" : "HELLO FRAME of 17",
  );
  await page.evaluate(() => window.fixture.endModule());
  // A runtime that throws: the bootstrap reports it at once, long before
  // either time limit, and the host says the frame did not start.
  if (!process.env.PAGES_OUTPUT_LIVE) {
    await page.evaluate(() => window.fixture.bootFailure());
    await expect(page.locator("#boot-failure")).toHaveAttribute("data-error", BOOT_FAILURE, {
      timeout: 10000,
    });
    await page.evaluate(() => window.fixture.endBootFailure());
    // The frame reports the runtime's own error; nothing else may fail.
    const expected = errors.findIndex((message) => /a runtime that does not start/.test(message));
    if (expected !== -1) errors.splice(expected, 1);
  }
  // A module view through the Pages viewer: its model holds a whole file and
  // a Parquet table. Moving both sources updates them through
  // change: listeners in the same frame, with the view's own state intact.
  await page.evaluate(() => window.fixture.moduleView());
  const dataView = page.locator("#module-view2 .pages-anywidget-view");
  await expect(dataView).toHaveAttribute("data-output-state", "ready");
  const dataFrame = page.frameLocator("#module-view2 iframe");
  await expect(dataFrame.locator("#label")).toHaveText("first label");
  await expect(dataFrame.locator("#config")).toHaveText("hello");
  const columns = "day at at_ms people name score";
  await expect(dataFrame.locator("#table")).toHaveText(`5 rows of ${columns}`);
  await dataFrame.locator("#count").click();
  await dataFrame.locator("#count").click();
  await expect(dataFrame.locator("#count")).toHaveText("2");
  await page.locator("#module-view2 iframe").evaluate((frame) => {
    frame.dataset.marker = "kept";
  });
  await page.evaluate(() => window.fixture.moveData());
  await expect(dataFrame.locator("#label")).toHaveText("second label");
  await expect(dataFrame.locator("#config")).toHaveText("howdy");
  await expect(dataFrame.locator("#table")).toHaveText(`9 rows of ${columns}`);
  await expect(page.locator("#module-view2 iframe")).toHaveCount(1);
  await expect(page.locator("#module-view2 iframe")).toHaveAttribute("data-marker", "kept");
  await expect(dataFrame.locator("#count")).toHaveText("2");
  await expect(dataView).toHaveAttribute("data-output-state", "ready");
  await page.evaluate(() => window.fixture.endModuleView());
  // A module view that reads its file once and never listens is mounted
  // again when that file changes, and shows the new value.
  await page.evaluate(() => window.fixture.onceView());
  const onceView = page.locator("#module-view3 .pages-anywidget-view");
  await expect(onceView).toHaveAttribute("data-output-state", "ready");
  const onceFrame = page.frameLocator("#module-view3 iframe");
  await expect(onceFrame.locator("#once")).toHaveText("first label");
  await page.locator("#module-view3 iframe").evaluate((frame) => {
    frame.dataset.marker = "first";
  });
  await page.evaluate(() => window.fixture.moveOnce());
  await expect(onceFrame.locator("#once")).toHaveText("second label");
  await expect(page.locator("#module-view3 iframe")).toHaveCount(1);
  await expect(page.locator("#module-view3 iframe")).not.toHaveAttribute("data-marker", "first");
  await expect(onceView).toHaveAttribute("data-output-state", "ready");
  await page.evaluate(() => window.fixture.endOnceView());
  // A module view draws its Parquet table with Plot from model.get, with an
  // int64, a string and a nullable float column on a time axis. A new file
  // redraws through the listener in the same frame. The data/ import reads
  // the Parquet file itself.
  await page.evaluate(() => window.fixture.plotView());
  const plotView = page.locator("#module-view4 .pages-anywidget-view");
  await expect
    .poll(async () =>
      plotView.evaluate((el) => el.dataset.outputState + " " + el.querySelector("p")?.textContent),
    )
    .toBe("ready ");
  const plotFrame = page.frameLocator("#module-view4 iframe");
  const plotMain = plotFrame.locator("main");
  await expect(plotMain.locator("svg circle")).toHaveCount(5);
  await expect(plotMain.locator("svg path[d]").first()).toBeAttached();
  await expect(plotMain.locator("svg text").filter({ hasText: "day 3" })).toHaveCount(1);
  await expect(plotMain).toHaveAttribute("data-x-scale", "utc");
  await expect(plotFrame.locator("#head")).toHaveText(`PAR1 of ${entries.table1[0].length}`);
  await expect(plotMain).toHaveAttribute("data-same-file", "true");
  await page.locator("#module-view4 iframe").evaluate((frame) => {
    frame.dataset.marker = "kept";
  });
  await page.evaluate(() => window.fixture.movePlot());
  await expect(plotMain.locator("svg circle")).toHaveCount(9);
  await expect(plotMain).toHaveAttribute("data-draws", "2");
  await expect(page.locator("#module-view4 iframe")).toHaveCount(1);
  await expect(page.locator("#module-view4 iframe")).toHaveAttribute("data-marker", "kept");
  await expect(plotView).toHaveAttribute("data-output-state", "ready");
  await page.evaluate(() => window.fixture.endPlotView());
  // A module view draws a CSV source with Plot from model.get(name).csv():
  // the page converts it to Arrow IPC with Sift's CSV WASM, and the frame
  // gets typed rows with their columns.
  await page.evaluate(() => window.fixture.csvView());
  const csvView = page.locator("#module-view5 .pages-anywidget-view");
  await expect.poll(async () => csvView.getAttribute("data-output-state")).toBe("ready");
  const csvMain = page.frameLocator("#module-view5 iframe").locator("main");
  await expect(csvMain.locator("#rows")).toHaveText(
    "3|city people founded open|Oslo, NO|number|true|false|",
  );
  await expect(csvMain.locator("svg circle")).toHaveCount(2);
  await expect(csvMain).toHaveAttribute("data-x-scale", "utc");
  await page.evaluate(() => window.fixture.endCsvView());
  await expect(page.getByRole("button", { name: "Retry interactive view" })).toBeHidden();
  const frame = page.frameLocator("iframe");
  await expect(frame.getByRole("heading", { name: "Listen and explore" })).toBeVisible();
  assert.equal(await frame.locator("audio").evaluate((audio) => audio.paused), true);
  await frame.getByRole("slider").click();
  await frame.locator("audio").evaluate(async (audio) => {
    await audio.play();
    audio.pause();
  });
  await frame.getByRole("slider").fill("0.75");
  await expect(frame.locator("output")).toHaveText("0.75");
  assert.ok(await frame.locator("audio").evaluate((a) => Math.abs(a.currentTime - 0.75) < 0.05));
  const themeMatches = async (expected) => {
    await expect(frame.locator("html")).toHaveAttribute("data-theme", expected);
    await expect(frame.locator("main")).toHaveAttribute("data-theme", expected);
    const background = await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(
      await frame.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor),
      background,
    );
    assert.equal(
      await frame.locator("html").evaluate((el) => getComputedStyle(el).colorScheme),
      expected,
    );
  };
  const frameUrl = await page.locator("iframe").getAttribute("src");
  await themeMatches("light"); // Explicit light wins even though OS is dark.
  await page.getByLabel("Appearance").selectOption("dark");
  await themeMatches("dark");
  await page.getByLabel("Appearance").selectOption("system");
  await themeMatches("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await themeMatches("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await themeMatches("dark");
  await page.getByLabel("Appearance").selectOption("light");
  await themeMatches("light");
  assert.equal(await page.locator("iframe").getAttribute("src"), frameUrl);
  await expect(frame.locator("output")).toHaveText("0.75");
  await page.screenshot({ path: new URL("wide.png", out).pathname });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL("narrow.png", out).pathname });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => window.postMessage({ type: "error", message: "forged" }, "*"));
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  // A new recording is a buffer change: the same frame keeps its local state.
  await page.evaluate(() => window.fixture.change());
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  await expect(frame.locator("main")).toHaveAttribute("data-recording-changes", "1");
  assert.equal(await page.locator("iframe").getAttribute("src"), frameUrl);
  await expect(frame.locator("output")).toHaveText("0.75");
  await expect(page.getByRole("button", { name: "Retry interactive view" })).toBeHidden();
  // A code change remounts; its failed load can be retried.
  await page.evaluate(() => window.fixture.transient());
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "failed");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry interactive view" }).click();
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  if (process.env.PAGES_OUTPUT_CDN) {
    await page.evaluate(() => window.fixture.example());
    await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready", {
      timeout: 30000,
    });
    await expect(frame.locator("canvas")).toBeVisible();
    await page.screenshot({ path: new URL("dmel-narrow.png", out).pathname });
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.screenshot({ path: new URL("dmel-wide.png", out).pathname });
    await page.getByLabel("Appearance").selectOption("dark");
    await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: new URL("dmel-dark.png", out).pathname });
    await page.getByLabel("Appearance").selectOption("light");
  }
  await page.evaluate(() => window.fixture.layout());
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  const assertFits = async () => {
    await expect
      .poll(async () =>
        frame.locator("html").evaluate((html) => ({
          overflowX: html.scrollWidth - html.clientWidth,
          scrollbarWidth: innerWidth - html.clientWidth,
          overflowY: html.scrollHeight - html.clientHeight,
          inset: document.body.getBoundingClientRect().left,
          heightDifference: Math.abs(innerHeight - document.body.getBoundingClientRect().height),
        })),
      )
      .toMatchObject({ overflowX: 0, overflowY: 0, scrollbarWidth: 0, inset: 0 });
    // ResizeObserver -> MessagePort -> parent style is asynchronous. Wait for
    // that delivered measurement after changing the viewport, not just ready.
    await expect
      .poll(
        async () => {
          const gap = await frame
            .locator("body")
            .evaluate((body) => innerHeight - body.getBoundingClientRect().height);
          return gap >= 0 && gap < 1;
        },
        { message: "Frame fits its measured content without guessed padding" },
      )
      .toBe(true);
  };
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await assertFits();
    assert.ok((await page.locator("iframe").boundingBox()).height > 1600);
    const slider = frame.getByRole("slider", { name: "Selection" });
    assert.ok((await slider.boundingBox()).height >= 44);
    await expect(slider).toHaveCSS("touch-action", "pan-y pinch-zoom");
    await slider.tap({ position: { x: (await slider.boundingBox()).width * 0.8, y: 5 } });
    assert.ok(Number(await slider.inputValue()) > 5, "Touch near the track hits the larger target");
    await slider.fill("8");
    await expect(slider).toHaveValue("8");
    await frame.getByRole("button", { name: "Toggle height" }).click();
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox()).height)
      .toBeLessThan(700);
    await assertFits();
    const region = frame.getByRole("region", { name: "Wide results" });
    const scroll = await region.evaluate((el) => {
      el.scrollLeft = 100;
      el.scrollTop = 50;
      return { x: el.scrollLeft, y: el.scrollTop };
    });
    assert.deepEqual(scroll, { x: 100, y: 50 });
    await page.screenshot({ path: new URL(`layout-${width}.png`, out).pathname });
    await frame.getByRole("button", { name: "Toggle height" }).click();
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox()).height)
      .toBeGreaterThan(1600);
  }
  // This frontend is the unchanged upstream getting-started widget. It knows
  // nothing about Pages, our transport, theme extensions or source bindings.
  await page.evaluate(() => window.fixture.counter());
  await expect(frame.getByRole("button", { name: "count is 42" })).toBeVisible();
  await expect(frame.getByRole("button")).toHaveCSS("background-color", "rgb(234, 88, 12)");
  await frame.getByRole("button").click();
  await expect(frame.getByRole("button")).toHaveText("count is 43");
  await page.getByLabel("Appearance").selectOption("dark");
  await expect(frame.getByRole("button")).toHaveText("count is 43");
  await page.screenshot({ path: new URL("upstream-counter-narrow.png", out).pathname });
  await page.evaluate(() => window.fixture.counter(true));
  await expect(frame.getByRole("button", { name: "count is 42" })).toHaveCount(2);
  await frame.getByRole("button").first().click();
  await expect(frame.getByRole("button", { name: "count is 43" })).toHaveCount(2);
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.screenshot({ path: new URL("upstream-composed-wide.png", out).pathname });
  await page.getByLabel("Appearance").selectOption("light");
  await page.evaluate(() => window.fixture.audio());
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "ready");
  await page.evaluate(() => window.fixture.fail());
  await expect(page.locator("section")).toHaveAttribute("data-output-state", "failed");
  await expect(page.getByText("intentional failure")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.evaluate(() => window.fixture.destroy());
  // Selecting a Wordgard view used to wrap/reparent its iframe, which reloads
  // the document and trips the navigation guard. The local model must survive.
  await page.evaluate(() => window.fixture.editor());
  await expect(frame.getByRole("button", { name: "count is 42" })).toBeVisible();
  let loads = 0;
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) loads++;
  });
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await frame.getByRole("button").click();
    const count = width === 1200 ? "count is 43" : "count is 44";
    for (const selected of [true, false]) {
      await page.evaluate((selected) => window.fixture.select(selected), selected);
      await expect(frame.getByRole("button")).toHaveText(count);
      await expect(page.locator(".pages-anywidget-view")).toHaveAttribute(
        "data-output-state",
        "ready",
      );
    }
  }
  // A peer selection disappears when that peer leaves the editor/window.
  // The actual collaboration decorations must preserve the frame and model.
  for (const attributes of [
    { class: "peer-selection", title: "Collaborator", style: "--peer-color: teal" },
    { class: "comment-passage", "data-comment-thread": "thread" },
    null,
  ]) {
    await page.evaluate((value) => window.fixture.highlight(value), attributes);
    await expect(frame.getByRole("button")).toHaveText("count is 44");
    const wrapper = page.locator(".wordgard-view-node");
    if (attributes)
      for (const [name, value] of Object.entries(attributes))
        if (name === "class") await expect(wrapper).toHaveClass(new RegExp(value));
        else await expect(wrapper).toHaveAttribute(name, value);
  }
  await page.evaluate(() => {
    window.fixture.select(true);
    window.fixture.focus();
  });
  await page.locator("#appearance").focus();
  await expect(frame.getByRole("button")).toHaveText("count is 44");
  await page.evaluate(() => window.fixture.focus());
  for (const readonly of [true, false]) {
    await page.evaluate((value) => window.fixture.readonly(value), readonly);
    await expect(frame.getByRole("button")).toHaveText("count is 44");
  }
  assert.equal(
    loads,
    0,
    "Selection, collaboration highlights, blur and permissions must not reload the frame",
  );
  // A former chart's reserve must not pad a short widget or a terminal error.
  const embed = page.locator(".wordgard-view-embed");
  await embed.evaluate((el) => el.style.setProperty("--pages-view-reserve", "900px"));
  await expect.poll(async () => (await embed.boundingBox()).height).toBeLessThan(300);
  await page.evaluate(() => {
    window.fixture.audio();
    window.fixture.fail();
  });
  await expect(page.locator(".pages-anywidget-view")).toHaveAttribute(
    "data-output-state",
    "failed",
  );
  await expect.poll(async () => (await embed.boundingBox()).height).toBeLessThan(300);
  await page.evaluate(() => window.fixture.unavailable());
  await expect(page.locator(".pages-anywidget-view")).toHaveAttribute(
    "data-output-state",
    "unavailable",
  );
  await expect.poll(async () => (await embed.boundingBox()).height).toBeLessThan(300);

  assert.deepEqual(errors, []);
  await writeFile(
    new URL("report.json", out),
    JSON.stringify(
      {
        passed: [
          "opaque DOM/storage boundary",
          "deployment-selected iframe endpoint read from the shell",
          "WAV DataView",
          "unchanged upstream anywidget counter + CSS; local state resets on remount",
          "child composition shares one local model across two views",
          "initialize before render",
          "local model and seeking",
          "wide/narrow",
          "shared controls, margin/float sizing, tall growth/shrink and explicit scroll regions",
          "resolved light/dark/system theme updates preserve widget state",
          "forged ambient message",
          "automatic render; a new recording reaches the model without a remount",
          "code-change remount",
          "module view model: a whole file and a Parquet table change in place through change: listeners",
          "module view draws await model.get(name).parquet() with Plot: int64, string, nullable float, temporal axis; a new file redraws in the same frame; the data/ import is the same file object and its slice reads PAR1",
          "module view reads text and JSON files on request and redraws them in place after a data change",
          "a module view with no change listener is mounted again with its new data",
          "retry after a transient input failure",
          "failure recovery",
          "Wordgard node selection preserves iframe document and local model at wide/narrow widths",
          "module view resolves a Page import, a data/ file and a catalog import through the frame's import map",
        ],
        browser: engine,
        live: !!process.env.PAGES_OUTPUT_LIVE,
      },
      null,
      2,
    ),
  );
  console.log("Output smoke passed");
} catch (error) {
  const failed = browser.contexts()[0]?.pages()[0];
  if (failed) {
    console.error(await failed.locator("body").innerText());
    await failed.screenshot({ path: new URL("failure.png", out).pathname });
  }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
