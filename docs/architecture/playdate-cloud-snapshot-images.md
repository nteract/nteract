# Playdate Cloud Snapshot Images

**Status:** Prototype note, 2026-05-27.

## Summary

Use `pdc` as the PDI encoder. Normalize notebook image outputs to a
Playdate-ready PNG first, then compile that PNG to PDI with the Playdate SDK and
store the resulting PDI as a derived content-addressed blob. Do not try to run
this conversion inside the Cloudflare Worker prototype; treat it as publish-time
or build-time work performed by a runtime/publisher service that has the
Playdate SDK installed.

Prefer `image/vnd.playdate.pdi` as the prototype MIME for raw PDI bytes.
`image/pdi` looks like an unregistered standards-tree type, and `image/x-*`
prefixes are discouraged by the media-type RFCs. If the payload becomes an
nteract-specific wrapper rather than raw PDI bytes, use an nteract vendor type
for the wrapper and keep the raw PDI blob labeled separately.

## Current nteract Shape

Published cloud revisions are durable snapshot pairs plus blobs:

- `n/{id}/snapshots/{notebookHeadsHash}.am`
- `n/{id}/snapshots/runtime-state/{runtimeHeadsHash}.am`
- `n/{id}/blobs/{sha256}`
- `n/{id}/renders/{notebookHeadsHash}.json`

`apps/notebook-cloud/src/snapshot-render.ts` loads the notebook/runtime pair
through `runtimed-wasm`, parses `get_cells_json()`, and adds a `blob_urls`
inventory via `collectBlobUrls()`. `materializeSnapshotRenderCache()` validates
that every referenced blob exists in R2 before it records the render cache.

Binary image outputs are already blob-shaped. `notebook_doc::mime` classifies
`image/*` as binary except SVG, so PNG/JPEG bytes stay out of Automerge and live
as content-addressed blobs. `runtimed-outputs` can synthesize `text/llm+plain`
for binary media, but the current cloud render cache does not produce
Playdate-specific derived image variants.

## SDK Findings

Tested SDK: `/Users/kyle/Developer/PlaydateSDK`, `pdc --version` = `3.0.6`.

The SDK docs say PNG and GIF images in a source folder are compiled by `pdc`
into Playdate `.pdi` files, and Lua loads them through
`playdate.graphics.image.new(path)`. Playdate images are 1 bit per pixel with
an optional alpha channel. The device display is 400 x 240.

`pdc` can compile a single PNG input directly enough for server-side harvesting:

```sh
/Users/kyle/Developer/PlaydateSDK/bin/pdc input.png output-name
```

That creates `output-name.pdx/<input-basename>.pdi`. It does not emit a bare
`.pdi` file path. A source directory compile also works:

```sh
/Users/kyle/Developer/PlaydateSDK/bin/pdc Source build/CloudSnapshotPdiFixture.pdx
```

JPEG is not accepted by `pdc` directly. The tested JPEG command returned:

```text
error: unexpected file type at .context/playdate-pdi-edge/src/assets/cloud-figure.jpg
```

So JPEG/WebP/BMP/SVG/etc. must be decoded or rasterized to PNG first.

## Fixture

Fixture path: `examples/playdate-pdi-fixture`.

Run:

```sh
examples/playdate-pdi-fixture/scripts/verify.sh
```

The verifier generates a deterministic 128 x 80 1-bit PNG, checks it with the
Playdate harness sprite validator, compiles it with `pdc`, verifies the PDI
exists, and runs a Simulator autotest through:

```sh
/Users/kyle/codex/playdate-harness/scripts/sim_autotest.py \
  --project examples/playdate-pdi-fixture \
  --name CloudSnapshotPdiFixture \
  --bundle-id com.nteract.cloud-snapshot-pdi-fixture \
  --out examples/playdate-pdi-fixture/qa/autotest-result.txt
```

Observed output from the passing run:

```text
pdi_size=243
AUTOTEST bundled_load=true
AUTOTEST bundled_pdi_exists=true
AUTOTEST byte_length=243
AUTOTEST copied_load=true
AUTOTEST copy_to_data=true
AUTOTEST datastore_read=true
AUTOTEST height=80
AUTOTEST result=PASS
AUTOTEST width=128
```

The Lua test loads the bundled PDI, copies the PDI bytes into the Simulator
Data folder with `playdate.file`, then loads that copied Data-folder PDI through
both `playdate.graphics.image.new()` and `playdate.datastore.readImage()`. This
is the key runtime finding for downloaded snapshot images: the Playdate app can
write fetched PDI bytes into its Data directory and load them later as images.

Generated artifacts are ignored by git:

- `examples/playdate-pdi-fixture/Source/assets/cloud-figure.png`
- `examples/playdate-pdi-fixture/build/CloudSnapshotPdiFixture.pdx/...`
- `examples/playdate-pdi-fixture/qa/autotest-result.txt`

## Recommended Conversion Path

For each notebook output candidate:

1. Select source MIME by Playdate source priority: `image/png`, `image/jpeg`,
   other `image/*`, then text fallbacks.
2. Fetch source blob bytes by hash.
3. Decode/rasterize outside the Worker. Use deterministic parameters:
   max width `400`, max height per block `240` unless the viewer explicitly
   supports taller scroll strips, fit mode, background color, alpha handling,
   threshold/dither mode, and orientation.
4. Convert to a strict black/white/transparent PNG. Use ordered dithers for
   chart-like grayscale; reserve error-diffusion dithers for photo-like inputs
   because they are noisier and less stable for labels.
5. Run `pdc normalized.png tmp-output`.
6. Read `tmp-output.pdx/normalized.pdi`.
7. Store the PDI bytes as a normal blob at `n/{id}/blobs/{pdiSha256}` with
   content type `image/vnd.playdate.pdi`.
8. Record a derived variant in a Playdate render projection/cache, not in
   `RuntimeStateDoc`.

Tall notebook content should not become one giant bitmap. Keep the contract at
cell/output-block granularity and let the Playdate app crank-scroll blocks.
For wide figures, produce a scaled 400 px-wide PDI plus metadata that records
the original dimensions and scale.

## Proposed Playdate Snapshot Contract

Add a target-specific render cache rather than changing the existing browser
render cache in place:

```text
n/{id}/renders/playdate/{notebookHeadsHash}.json
```

Shape:

```json
{
  "schema_version": 1,
  "target": "playdate",
  "generated_from": "snapshot-pair",
  "notebook_id": "demo",
  "heads_hash": "notebook-heads",
  "runtime_heads_hash": "runtime-heads",
  "cells": [
    {
      "id": "cell-1",
      "source": "plot(data)",
      "blocks": [
        {
          "kind": "image",
          "preferred_mime": "image/vnd.playdate.pdi",
          "blob": "pdi-sha256",
          "url": "/api/n/demo/blobs/pdi-sha256",
          "byte_length": 243,
          "width": 128,
          "height": 80,
          "source_mime": "image/png",
          "source_blob": "source-sha256",
          "conversion_key": "conversion-sha256",
          "dither": "threshold",
          "alpha": "preserve-mask",
          "alt": "Bar chart comparing four values"
        },
        {
          "kind": "text",
          "mime": "text/llm+plain",
          "text": "Image output (image/png, 45 KB)"
        }
      ]
    }
  ]
}
```

Cache key:

```text
sha256(canonical_json({
  source_blob,
  source_mime,
  target_mime: "image/vnd.playdate.pdi",
  max_width,
  max_height,
  fit,
  background,
  alpha,
  dither,
  threshold,
  sdk_version,
  converter_version
}))
```

Use the output PDI blob hash for immutable blob storage, and the conversion key
for lookup/dedup of derived variants. Include both. If the same source and
params produce the same PDI under a newer SDK, the PDI hash will dedupe; if the
SDK changes output bytes, the conversion key prevents stale reuse.

Playdate block selection order:

1. `image/vnd.playdate.pdi`
2. `image/jpeg` as source/link metadata only unless the device app grows a JPEG
   decoder
3. `text/markdown`
4. `text/llm+plain`

## Cloudflare Deployment Risks

The current Worker can materialize snapshot JSON and check R2 blobs, but it is
not the right place to run the Playdate SDK:

- `pdc` is a native SDK tool, not a Worker runtime API.
- Workers support precompiled WebAssembly, but threading is unavailable, WASI
  support is experimental, and memory is limited per isolate.
- Cloudflare Image Transformations can decode/resize common image formats and
  output PNG/JPEG/GIF/WebP/SVG/AVIF, but it cannot output Playdate PDI or apply
  the exact 1-bit/dither contract we need.

Practical deployment options:

1. Convert at publish time on the runtime peer or publisher machine and upload
   derived PDI blobs with the snapshot.
2. Run a separate conversion service outside Workers with the Playdate SDK
   installed, then let the Worker record/serve the derived blobs.
3. Use Cloudflare Images only as an optional pre-normalization step, not as the
   PDI encoder.

## Rust Note

The first prototype should stay Lua-side. `cargo search` shows
`playdate = 0.2.6` and `playdate-sys = 0.5.6` from `boozook/playdate`; these
are useful if the Playdate viewer moves to native Rust and needs direct
`loadBitmap` probing or performance work. They are not needed for the cloud
conversion path, because PDI creation is still driven by the SDK compiler.

## Open Risks

- Need a representative photo/chart corpus to choose default dithers. The tiny
  fixture proves loading, not visual quality.
- Need a hard size policy for large source images. Start with 400 px width and
  per-output blocks; avoid large full-notebook strips until memory behavior is
  measured on device.
- Need to decide whether Playdate projection generation is synchronous during
  snapshot publish or asynchronous with a `pending`/fallback response.
- Need to preserve human-authored alt text when available; otherwise synthesize
  a short summary from `text/plain`, `text/markdown`, or `text/llm+plain`.
