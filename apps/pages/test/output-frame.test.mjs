import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  checkEsmSpec,
  ESM_MEDIA_TYPE,
  ESM_VIEW_MEDIA_TYPE,
  WAV_MEDIA_TYPE,
} from "../shared/esm-view.mjs";
import { outputTransition, OUTPUT_STATES } from "@nteract/output-frame/lifecycle";
import { inspectOutputAsset } from "../shared/output-assets.mjs";
import { checkViewSpec } from "../shared/view-spec.mjs";
import { fetchOutputAsset } from "../viewer/output-assets.mjs";
import { validateViewOperation } from "../model/view-doc.mjs";

test("an ESM view binds exactly its module and inputs, without host URLs", () => {
  const spec = { module: "code", inputs: ["recording", "dmel"], state: { frame: 0 } };
  const data = Object.fromEntries(
    ["code", "recording", "dmel"].map((key) => [key, { source_id: key }]),
  );
  assert.equal(checkViewSpec(spec, data, ESM_VIEW_MEDIA_TYPE).ok, true);
  assert.equal(
    validateViewOperation({
      op: "set_view",
      view_id: "audio",
      title: "Listen",
      media_type: ESM_VIEW_MEDIA_TYPE,
      spec,
      data,
      view_revision: null,
    }).spec,
    spec,
  );
  for (const bad of [
    { ...spec, inputs: ["code"] },
    { ...spec, inputs: ["__proto__"] },
    { ...spec, module: "https://example.com/code.js" },
    { ...spec, state: { recording: "override" } },
    { ...spec, credentials: true },
  ])
    assert.equal(checkEsmSpec(bad).ok, false);
  assert.equal(
    checkViewSpec(spec, { ...data, unrelated: { source_id: "secret" } }, ESM_VIEW_MEDIA_TYPE).ok,
    false,
  );
});

test("every lifecycle state/event is defined and stopped mounts never revive", () => {
  const events = [
    "connect",
    "connected",
    "mount",
    "loaded",
    "initialized",
    "rendered",
    "fail",
    "dispose",
    "unknown",
  ];
  for (const state of OUTPUT_STATES)
    for (const event of events) assert.ok(OUTPUT_STATES.includes(outputTransition(state, event)));
  let state = "connecting";
  for (const [event, next] of [
    ["connect", "handshaking"],
    ["connected", "loading"],
    ["mount", "importing"],
    ["loaded", "initializing"],
    ["initialized", "rendering"],
    ["rendered", "ready"],
    ["dispose", "disposed"],
  ])
    assert.equal((state = outputTransition(state, event)), next);
  for (const event of events) assert.equal(outputTransition("disposed", event), "disposed");
  for (const event of ["connect", "connected", "mount", "loaded", "initialized", "rendered"])
    assert.equal(outputTransition("failed", event), "failed");
});

test("ESM is validated as text, while WAV requires a real container", () => {
  assert.equal(
    inspectOutputAsset(new TextEncoder().encode("export default {}"), ESM_MEDIA_TYPE).mime_type,
    ESM_MEDIA_TYPE,
  );
  for (const bad of [new Uint8Array([255]), new Uint8Array([0]), new Uint8Array()])
    assert.throws(() => inspectOutputAsset(bad, ESM_MEDIA_TYPE));
  assert.throws(() => inspectOutputAsset(new TextEncoder().encode("RIFFinvalid"), WAV_MEDIA_TYPE));
});

test("binary reads are scoped, bounded, media-checked and content-checked", async () => {
  const bytes = new TextEncoder().encode("export default {}"),
    pageId = "33333333-3333-4333-8333-333333333333";
  const version = {
    asset_id: createHash("sha256").update(bytes).digest("hex"),
    media_type: ESM_MEDIA_TYPE,
  };
  const request = async (url, options) => {
    assert.equal(url, `/api/pages/${pageId}/assets/${version.asset_id}`);
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.redirect, "error");
    return new Response(bytes, { headers: { "content-type": ESM_MEDIA_TYPE } });
  };
  const result = await fetchOutputAsset(pageId, version, { request });
  assert.deepEqual(result.bytes, bytes);
  assert.notEqual(result.bytes.buffer, bytes.buffer);
  await assert.rejects(
    fetchOutputAsset(pageId, version, {
      request: async () => new Response("wrong", { headers: { "content-type": ESM_MEDIA_TYPE } }),
    }),
    /hash/,
  );
  await assert.rejects(
    fetchOutputAsset(pageId, version, {
      request: async () => new Response(bytes, { headers: { "content-type": "text/html" } }),
    }),
    /media type/,
  );
  await assert.rejects(
    fetchOutputAsset(pageId, { ...version, asset_id: "../secret" }, { request }),
    /Invalid/,
  );
  await assert.rejects(
    fetchOutputAsset(pageId, version, {
      request: async () =>
        new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
          headers: { "content-type": ESM_MEDIA_TYPE },
        }),
    }),
    /5 MiB/,
  );
});

test("frame startup timeout and teardown use an injected clock", async (t) => {
  const { JSDOM } = await import("jsdom");
  const { VirtualTimeScheduler } = await import("rxjs");
  const { mountEsmOutput } = await import("@nteract/output-frame");
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  t.after(() => dom.window.close());
  const clock = new VirtualTimeScheduler();
  const states = [];
  const output = mountEsmOutput(
    dom.window.document.querySelector("main"),
    {
      module: {
        bytes: new TextEncoder().encode("export default {}"),
        mediaType: "text/javascript",
      },
      inputs: {},
    },
    {
      frameUrl: "https://outputs.example/frame/v1/",
      hostContext: { theme: "light" },
      timeoutMs: 100,
      scheduler: clock,
      onState: (state) => states.push(state),
    },
  );
  assert.equal(output.frame.getAttribute("sandbox"), "allow-scripts");
  clock.flush();
  assert.equal(output.state, "failed");
  assert.equal(output.frame.isConnected, false);
  output.destroy();
  output.destroy();
  assert.deepEqual(states, ["connecting", "failed", "disposed"]);
});

test("binary transport does not expose bytes outside an authorized subarray", async () => {
  const { preparePayload } = await import("../../../packages/output-frame/src/payload.mjs");
  const backing = new Uint8Array([99, 1, 2, 99]);
  const payload = preparePayload({
    module: { bytes: backing.subarray(1, 3), mediaType: ESM_MEDIA_TYPE },
    inputs: {},
    state: {},
  });
  assert.deepEqual([...new Uint8Array(payload.module.bytes.buffer)], [1, 2]);
  assert.notEqual(payload.module.bytes.buffer, backing.buffer);
});

test("host context requires resolved themes and replaces a bounded token set", async () => {
  const { JSDOM } = await import("jsdom");
  const { normalizeHostContext, applyHostContext } = await import("@nteract/output-frame/context");
  assert.throws(() => normalizeHostContext({ theme: "system" }), /resolve/);
  const dom = new JSDOM("<main></main>");
  try {
    const dark = applyHostContext(dom.window.document, {
      theme: "dark",
      styles: {
        variables: {
          "--background": "#111111",
          "--primary": "#abcdef",
          "--private-value": "secret",
        },
      },
    });
    const root = dom.window.document.documentElement;
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.style.colorScheme, "dark");
    assert.ok(root.classList.contains("dark"));
    assert.equal(root.style.getPropertyValue("--primary"), "#abcdef");
    assert.equal(root.style.getPropertyValue("--private-value"), "");
    assert.ok(Object.isFrozen(dark.styles.variables));
    applyHostContext(dom.window.document, { theme: "light" });
    assert.equal(root.style.getPropertyValue("--primary"), "");
    assert.equal(root.style.colorScheme, "light");
    assert.equal(root.classList.contains("dark"), false);
  } finally {
    dom.window.close();
  }
});
