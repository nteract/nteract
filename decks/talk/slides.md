---
theme: seriph
title: Give Your Agents REPLs
info: |
  In-repo Slidev deck that doubles as the talk and the prototype surface
  for embedding live nteract execution results in slides.
class: text-center
transition: slide-left
---

# Give Your Agents REPLs

A live deck wired into the nteract dev daemon.

<div class="abs-br m-6 text-xl opacity-50">
  decks/talk in the nteract monorepo
</div>

---

## What this deck proves

- The same `vite-plugin-browser-relay` that powers `apps/notebook` runs in this Slidev dev server
- The deck shares the per-worktree daemon socket via the same auth-pinned WebSocket
- We can embed live cell outputs in slides without leaving the talk

---
layout: center
---

## Dev relay status

<RelayStatus />

If you see a daemon version and a socket path above, the in-deck relay is talking to your worktree daemon and we have everything we need to wire up live cell outputs next.

---

## Live dataframe from the dev daemon

<NteractCell
  blob="9afbf2fd52f85bed3fdba86ae579b95a5d8cac7a063d4e9e506392b3cd0908e1"
  label="notebook fbb0626a · cell-2a7d7f8b · execute_result"
/>

That iframe is served by the per-worktree daemon's blob HTTP server. The deck resolved the port from `/__nteract_dev_relay/config`; no other daemon plumbing.

---

## What the agent actually sees

<script setup>
import mathnetManifest from "./data/mathnet-manifest.json";
</script>

<NteractSiftCell
  label="100 problems from ShadenA/MathNet · loaded as a datasets.Dataset"
  :manifest="mathnetManifest"
/>

Loaded as a `datasets.Dataset` (not `.to_pandas()`'d), so the `huggingface` schema metadata survives and sift's rich-type detection is in play. The full dataset has 18.8% problems with `images` columns (geometry diagrams); we trim them here for slide weight, not because the wire can't carry them.

---

## Next

- `decks/talk/composables/useNteractSession.ts` — wasm + sync engine + transport composition (stub). Replaces hardcoded blob hashes with reactive cell lookups so re-running the cell upstream updates the slide live.
- `decks/talk/components/NteractCell.vue` — currently iframe-embeds a known blob. Once the composable lands, takes `notebookId` + `cellId` and resolves the manifest automatically.
