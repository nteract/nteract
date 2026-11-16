import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { compileAnywidgetSpec } from "../shared/anywidget-spec.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { checkView, readView, setView, viewGenesis, viewSummary } from "../model/view-doc.mjs";
import { anywidgetPlan } from "../viewer/anywidget-view.mjs";
const { preparePayload } = await import(
  new URL("./payload.mjs", import.meta.resolve("@nteract/output-frame"))
);
import { widgetState } from "@nteract/output-frame/schema";

const source = (source_id, revision) => ({ source_id, ...(revision && { revision }) });
const operation = (spec) => ({
  op: "set_view",
  view_id: "widget",
  title: "Widget",
  media_type: ANYWIDGET_MEDIA_TYPE,
  spec,
  view_revision: null,
});
const writer = { principal: "account:test", displayName: "Test", driver: "Agent" };
const id = "11111111-1111-4111-8111-111111111111";
const hashes = { code: "a".repeat(64), style: "b".repeat(64), binary: "c".repeat(64) };
function sources() {
  return A.change(sourcesGenesis(id), (draft) =>
    setSources(
      draft,
      Object.entries(hashes).map(([source_id, asset_id]) => ({
        op: "set_source",
        source_id,
        name: source_id,
        asset_id,
        source_revision: null,
      })),
      {
        by: writer,
        mediaTypes: new Map([
          [hashes.code, "text/javascript"],
          [hashes.style, "text/css"],
          [hashes.binary, "application/octet-stream"],
        ]),
      },
    ),
  );
}

test("direct references compile shared child modules and paired nested bytes into AFM model values", () => {
  const spec = {
    module: source("code"),
    stylesheet: source("style"),
    state: { nested: { samples: [null] }, child: "anywidget:child" },
    buffers: [{ source: source("binary", "1"), path: ["nested", "samples", 0] }],
    models: {
      child: {
        module: source("code"),
        buffers: [{ source: source("binary", "1"), path: ["bytes"] }],
      },
    },
  };
  const before = structuredClone(spec),
    compiled = compileAnywidgetSpec(spec);
  assert.equal(compiled.ok, true, compiled.error);
  assert.equal(new Set(compiled.dependencies.map((d) => d.name)).size, 3);
  assert.equal(compiled.spec._esm, compiled.spec.models.child._esm);
  const assets = Object.fromEntries(
    compiled.dependencies.map(({ name, source: ref }) => [
      name,
      {
        bytes:
          ref.source_id === "binary"
            ? new Uint8Array([99, 42, 99]).subarray(1, 2)
            : new TextEncoder().encode(ref.source_id === "code" ? "export default {}" : "button{}"),
        mediaType: {
          code: "text/javascript",
          style: "text/css",
          binary: "application/octet-stream",
        }[ref.source_id],
      },
    ]),
  );
  const payload = preparePayload({ spec: compiled.spec, assets });
  const state = widgetState(compiled.spec, payload.assets);
  assert.equal(state.nested.samples[0].getUint8(0), 42);
  assert.equal(state.nested.samples[0].buffer.byteLength, 1);
  assert.equal(state._esm, "export default {}");
  assert.equal(state.child, "anywidget:child");
  assert.equal(widgetState(compiled.spec.models.child, payload.assets).bytes.getUint8(0), 42);
  assert.deepEqual(spec, before, "compilation must not rewrite stored references or state");
  assert.equal(
    viewDependencies(operation(spec)).length,
    5,
    "enumerate each use, including repeated references",
  );
});

test("host admission checks module/CSS types, nested dependencies and retained pins before storing", () => {
  let sourcesDoc = sources();
  const valid = operation({
    module: source("code"),
    stylesheet: source("style"),
    buffers: [{ source: source("binary"), path: ["bytes"] }],
  });
  for (const [spec, code, message] of [
    [{ module: source("binary") }, "invalid_view", /spec.module.*text\/javascript/],
    [
      { module: source("code"), stylesheet: source("code") },
      "invalid_view",
      /spec.stylesheet.*text\/css/,
    ],
    [{ module: source("missing") }, "unknown_source", /spec.module/],
    [{ module: source("code", "9") }, "unknown_source_revision", /spec.module/],
    [
      { module: source("code"), models: { child: { module: source("binary") } } },
      "invalid_view",
      /spec.models.child.module/,
    ],
    [
      { module: source("code"), buffers: [{ source: source("missing"), path: ["bytes"] }] },
      "unknown_source",
      /buffers\[0\].source/,
    ],
  ])
    assert.throws(
      () => checkView(undefined, operation(spec), { sourcesDoc }),
      (error) => error.code === code && message.test(error.message),
    );
  const doc = A.change(viewGenesis(id), (draft) =>
    setView(draft, valid, { sourcesDoc, by: writer }),
  );
  const read = readView(doc, "widget");
  assert.deepEqual(read.spec, valid.spec);
  assert.equal(Object.hasOwn(read, "data"), false);
  assert.deepEqual(doc.data, {}, "generic record shape has no second source authority");
  assert.deepEqual(
    viewSummary(doc, "widget").dependencies.map((d) => d.source.source_id),
    ["code", "style", "binary"],
  );
  sourcesDoc = A.change(sourcesDoc, (draft) =>
    setSources(
      draft,
      [
        {
          op: "set_source",
          source_id: "code",
          name: "Code",
          asset_id: hashes.binary,
          source_revision: "1",
        },
      ],
      { by: writer, mediaTypes: new Map([[hashes.binary, "application/octet-stream"]]) },
    ),
  );
  assert.doesNotThrow(
    () => checkView(undefined, operation({ module: source("code", "1") }), { sourcesDoc }),
    "check the selected revision's media type, not latest",
  );
  assert.throws(() => checkView(undefined, valid, { sourcesDoc }), /text\/javascript/);
  assert.throws(
    () => checkView(doc, valid, { sourcesDoc: sources() }),
    (error) => error.code === "stale_view",
  );
});

test("following modules update while independent pins and child dependency subscriptions remain explicit", () => {
  const history = [
    null,
    { asset_id: hashes.code, media_type: "text/javascript", revision: "1" },
    { asset_id: "d".repeat(64), media_type: "text/javascript", revision: "2" },
  ];
  let current = 1;
  const resolver = { resolve: (ref) => history[ref.revision ?? current] };
  const view = operation({
    module: source("code"),
    models: { child: { module: source("code", "1") } },
  });
  const before = anywidgetPlan(view, resolver);
  current = 2;
  const after = anywidgetPlan(view, resolver);
  assert.notEqual(after.key, before.key);
  assert.equal(after.versions[after.spec._esm].revision, "2");
  assert.equal(after.versions[after.spec.models.child._esm].revision, "1");
  assert.notEqual(after.spec._esm, after.spec.models.child._esm);
  const pinned = { ...view, spec: { module: source("code", "1") } };
  const stable = anywidgetPlan(pinned, resolver).key;
  current = 1;
  assert.equal(anywidgetPlan(pinned, resolver).key, stable);
  assert.throws(
    () => anywidgetPlan(view, { resolve: () => ({ media_type: "audio/wav" }) }),
    /spec.module.*text\/javascript/,
  );
});

test("direct-reference schema refuses aliases, unsafe paths, malformed pairs and unbounded definitions", () => {
  for (const spec of [
    { _esm: "code" },
    { module: "code" },
    { module: { source_id: "code", revision: null } },
    { module: { source_id: "code", asset_id: hashes.code } },
    { module: source("constructor") },
    { module: source("code"), _css: "style" },
    { module: source("code"), buffers: ["binary"] },
    { module: source("code"), buffers: [{ source: source("binary") }] },
    { module: source("code"), buffers: [{ source: source("binary"), path: ["__proto__"] }] },
    { module: source("code"), buffers: [{ source: source("binary"), path: ["absent", "child"] }] },
    { module: source("code"), buffers: [{ source: source("binary"), path: ["_esm"] }] },
    {
      module: source("code"),
      state: { a: {} },
      buffers: [
        { source: source("binary"), path: ["a"] },
        { source: source("binary"), path: ["a", "b"] },
      ],
    },
    { module: source("code"), models: { root: { module: source("code") } } },
    {
      module: source("code"),
      models: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [`m${i}`, { module: source("code") }]),
      ),
    },
    {
      module: source("code"),
      buffers: Array.from({ length: 32 }, (_, i) => ({ source: source(`s${i}`), path: [`v${i}`] })),
    },
  ])
    assert.equal(compileAnywidgetSpec(spec).ok, false, JSON.stringify(spec));
  assert.throws(
    () =>
      checkView(
        undefined,
        { ...operation({ module: source("code") }), data: {} },
        { sourcesDoc: sources() },
      ),
    /omit data/,
  );
  assert.throws(
    () =>
      checkView(
        undefined,
        {
          ...operation({ module: source("code") }),
          media_type: "application/vnd.nteract.anywidget.v1+json",
        },
        { sourcesDoc: sources() },
      ),
    /media_type/,
  );
});
