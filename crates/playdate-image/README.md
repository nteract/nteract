# playdate-image

`playdate-image` converts notebook image outputs into a small Playdate-oriented
bitmap blob that nteract cloud can store and serve without the Playdate SDK.

The crate is intentionally not a Playdate app/runtime crate. It does not depend
on `pdc`, `playdate`, or `playdate-sys`; those belong in a separate Playdate
viewer if the viewer is written in Rust.

## Recommended Path

For cloud snapshots, prefer a target-specific derived image blob over PDI:

1. Decode source `image/png`, `image/jpeg`, `image/gif`, or `image/webp`.
2. Resize to viewer constraints, defaulting to 400 x 240.
3. Quantize to 1-bit with the requested dither mode.
4. Reject payloads above the configured output byte budget.
5. Store the `application/x-nteract-playdate-bitmap` payload in the snapshot
   blob store.
6. Let the Playdate viewer render the packed rows with a native helper.

This avoids running the Playdate SDK in Cloudflare while still keeping the
viewer payload close to the hardware representation. A Rust Playdate viewer can
use `playdate-graphics` raw framebuffer APIs (`get_frame` and
`mark_updated_rows`) to copy each payload row into the display buffer. A C
helper can do the same with `playdate->graphics->getFrame()` and
`markUpdatedRows()`. Lua can remain responsible for scrolling and UI state, but
should not draw large images pixel-by-pixel.

## Payload

Content type: `application/x-nteract-playdate-bitmap`

Binary layout is little-endian:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | Magic bytes `NTPDIMG1` |
| 8 | 2 | Width in pixels |
| 10 | 2 | Height in pixels |
| 12 | 2 | Source row stride in bytes |
| 14 | 2 | Flags, currently `0` |
| 16 | n | Packed 1-bit rows |

Pixels are MSB-first in each byte, matching Playdate graphics conventions:
white is `1`, black is `0`. Transparent source pixels are flattened to white for
the first version of the format. Trailing padding bits in partial bytes are also
set to white.

The payload stride is `ceil(width / 8)`, not the Playdate framebuffer stride.
For full-width 400-pixel rows this is 50 bytes; the hardware framebuffer row is
52 bytes, so the viewer copies 50 bytes per row and skips the framebuffer
padding.

## Snapshot Contract

Represent a converted image output as a derived blob attached to the original
output item:

- `content_type`: `application/x-nteract-playdate-bitmap`
- `blob_ref`: storage key for the payload bytes
- `width`, `height`
- `byte_length`
- `row_stride`
- `source_mime`
- `source_blob_hash`
- `dither`: `threshold`, `bayer2x2`, `bayer4x4`, or `bayer8x8`
- `max_width`, `max_height`
- `max_output_bytes`
- `alt_text` or generated summary when available

Use a cache key derived from:

```text
playdate-image:v1:<source-blob-hash>:<source-mime>:<max-width>x<max-height>:<dither>
```

If conversion fails or a viewer cannot consume the derived blob, fallback order
should be:

1. `image/jpeg` when the viewer has a suitable decoder path
2. `text/markdown`
3. `text/llm+plain`

## SDK Findings

The SDK path tested locally was `/Users/kyle/Developer/PlaydateSDK`.

Useful commands and findings:

```bash
/Users/kyle/Developer/PlaydateSDK/bin/pdc source.png compiled
```

This creates `compiled.pdx/source.pdi`. `pdc` does not produce a bare PDI at the
requested output path; it creates a `.pdx` directory and writes the compiled
asset inside it. Direct JPEG input was rejected by `pdc`, so any PDI workflow
would still need to decode JPEG to PNG first.

The Playdate SDK docs say PNG/GIF source images are compiled to PDI and
`playdate.datastore.readImage()` can only load compiled PDI files. That makes
PDI the right format for bundled SDK assets, but not a good Cloudflare-side
prototype target unless we either run `pdc` outside Cloudflare or implement the
PDI encoder ourselves.

The current crate takes the simpler route: store a custom packed bitmap blob and
render it in the Playdate viewer.

## Open Risks

- The first format flattens transparency to white. If notebook outputs rely on
  transparent overlays, add a second packed alpha mask and set a payload flag.
- Ordered dithering is deterministic and cheap, but plots with fine grid lines
  may need per-output tuning.
- Large notebook outputs should be pre-rendered into scroll-sized tiles if the
  viewer cannot keep a full report image in memory.
- The Playdate-side renderer still needs a small validation app or harness test
  that fetches or embeds an `NTPDIMG1` blob, blits rows into the framebuffer, and
  verifies the rendered screen in Simulator.
