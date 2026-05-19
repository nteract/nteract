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

<NteractSiftCell
  label="10,000 problems from ShadenA/MathNet · application/vnd.nteract.arrow-stream-manifest+json"
  :manifest='{
    "version": 1,
    "content_type": "application/vnd.apache.arrow.stream",
    "schema": {
      "hash": "6071d37f232e31698fc68eeef2806c62e9f4d20bd666512a4fe74cee52b43e08",
      "content_type": "application/vnd.apache.arrow.schema",
      "fields": 7,
      "columns": [
        {"name": "id",               "type": "large_string", "nullable": true},
        {"name": "country",          "type": "large_string", "nullable": true},
        {"name": "competition",      "type": "large_string", "nullable": true},
        {"name": "language",         "type": "large_string", "nullable": true},
        {"name": "problem_type",     "type": "large_string", "nullable": true},
        {"name": "final_answer",     "type": "large_string", "nullable": true},
        {"name": "problem_markdown", "type": "large_string", "nullable": true}
      ],
      "metadata": {"pandas": true, "huggingface": false}
    },
    "chunks": [
      {
        "index": 0,
        "hash": "252df7112c629958981b26d8bdab8d67cfd33bbdb772433bc960ed1c08b027c1",
        "size": 4475968,
        "row_count": 10000,
        "encoding": "arrow-ipc-stream"
      }
    ],
    "complete": true,
    "summary": {"total_rows": 10000, "included_rows": 10000, "sampled": false, "sample_strategy": "none"}
  }'
/>

Same isolated iframe and same plugin bundle as `apps/notebook`. Without this surface, the agent gets `<DataFrame 10000x7>` repr and burns turns reasoning about a shape it can't see. With it, the agent crossfilters `country=Russia, problem_type=Geometry` and reads `problem_markdown` directly.

---

## Next

- `decks/talk/composables/useNteractSession.ts` — wasm + sync engine + transport composition (stub). Replaces hardcoded blob hashes with reactive cell lookups so re-running the cell upstream updates the slide live.
- `decks/talk/components/NteractCell.vue` — currently iframe-embeds a known blob. Once the composable lands, takes `notebookId` + `cellId` and resolves the manifest automatically.
