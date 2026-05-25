# Sift Tables for Figma Slides

Local Figma Slides plugin for scanning Sift datasets in a plugin panel and inserting the visible table window into a slide.

This plugin runs the real `@nteract/sift` table in the plugin UI. Arrow IPC and Parquet sources go through the existing Sift WASM path. The Figma canvas output is intentionally a Figma-native table snapshot made from rectangles and text, because Figma's public Plugin API cannot create live `EMBED` interactive slide elements.

## Build

```sh
cargo xtask wasm sift
pnpm --filter @nteract/figma-sift-slides build
```

Load `plugins/figma-sift-slides/manifest.json` as a development plugin in the Figma desktop app.
