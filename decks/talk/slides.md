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

## Sift via the real plugin pipeline

<NteractSiftCell
  label="cell-2a7d7f8b as application/vnd.nteract.arrow-stream-manifest+json"
  :manifest='{
    "version": 1,
    "content_type": "application/vnd.apache.arrow.stream",
    "schema": {
      "hash": "0ab849774153ab8c1f72aad6470c161f0c5f926dc59f6d06ba942ebbc6ecc836",
      "content_type": "application/vnd.apache.arrow.schema",
      "fields": 4,
      "columns": [
        {"name": "ticker", "type": "large_string", "nullable": true},
        {"name": "price",  "type": "double",       "nullable": true},
        {"name": "volume", "type": "int64",        "nullable": true},
        {"name": "sector", "type": "large_string", "nullable": true}
      ],
      "metadata": {"pandas": true, "huggingface": false}
    },
    "chunks": [
      {
        "index": 0,
        "hash": "73d60bf8f0076e2284f9be8f09e297c57b9db187377f9a088e5734512eb2d1f4",
        "size": 1688,
        "row_count": 6,
        "encoding": "arrow-ipc-stream"
      }
    ],
    "complete": true,
    "summary": {"total_rows": 6, "included_rows": 6, "sampled": false, "sample_strategy": "none"}
  }'
/>

Same isolated iframe and same prebuilt plugin bundle as `apps/notebook`. The deck rewrites chunk hashes to blob-server URLs against the relay's advertised port; everything else flows through the existing render pipeline.

---

## Next

- `decks/talk/composables/useNteractSession.ts` — wasm + sync engine + transport composition (stub). Replaces hardcoded blob hashes with reactive cell lookups so re-running the cell upstream updates the slide live.
- `decks/talk/components/NteractCell.vue` — currently iframe-embeds a known blob. Once the composable lands, takes `notebookId` + `cellId` and resolves the manifest automatically.
