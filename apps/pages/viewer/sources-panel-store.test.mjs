import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { setSources, sourcesGenesis } from "../model/sources-doc.mjs";
import { Store } from "./store.mjs";
import {
  projectSourcesPanel,
  sourceMediaLabel,
  sourcesPanelStore,
} from "./sources-panel-store.mjs";

function sourceDoc() {
  return A.change(sourcesGenesis(crypto.randomUUID()), (draft) =>
    setSources(
      draft,
      [
        {
          op: "set_source",
          source_id: "usage",
          name: "Usage",
          asset_id: "a".repeat(64),
          source_revision: null,
        },
      ],
      {
        mediaTypes: new Map([["a".repeat(64), "application/vnd.apache.parquet"]]),
        by: { principal: "user:test", displayName: "Test", driver: "MCP" },
      },
    ),
  );
}
test("retains placement identity, named inputs and pins; incomplete views aren't called unused", () => {
  const result = projectSourcesPanel(
    sourceDoc(),
    {
      unreadableBlocks: 0,
      placements: [
        {
          key: "a:0",
          blockId: "a",
          kind: "dataframe",
          binding: { source_id: "usage", revision: "1" },
        },
        { key: "a:1", blockId: "a", kind: "dataframe" },
        { key: "b:0", blockId: "b", kind: "view", viewId: "chart" },
        { key: "c:0", blockId: "c", kind: "view", viewId: "chart" },
        { key: "d:0", blockId: "d", kind: "view", viewId: "unknown" },
      ],
    },
    {
      chart: {
        status: "ready",
        view: {
          title: "Activity",
          media_type: "application/vnd.nteract.anywidget.v1+json",
          data: { rows: { source_id: "usage" }, code: { source_id: "renderer" } },
        },
      },
    },
  );
  const usage = result.sources.find((s) => s.source_id === "usage");
  assert.equal(usage.uses.length, 3);
  assert.equal(usage.uses[0].revision, "1");
  assert.equal(new Set(usage.uses.map((u) => u.key)).size, 3);
  assert.equal(usage.uses[1].type, "Anywidget");
  assert.equal(usage.history.length, 1);
  assert.equal(result.sources.find((s) => s.source_id === "renderer").missing, true);
  assert.equal(result.unresolvedViews.length, 1);
});
test("media labels cover non-tabular assets and preserve unknown types", () => {
  assert.equal(sourceMediaLabel("text/css"), "CSS");
  assert.equal(sourceMediaLabel("audio/wav"), "WAV audio");
  assert.equal(sourceMediaLabel("application/octet-stream"), "Binary");
  assert.equal(sourceMediaLabel("application/future"), "application/future");
});
test("panel lifetime follows live sources and releases demand and listeners", () => {
  const doc$ = new BehaviorSubject(undefined);
  let demand = 0,
    listeners = 0;
  const session = {
    doc: undefined,
    subscribe: () => {
      listeners++;
      return () => listeners--;
    },
    sources: {
      doc$,
      state$: new Store({ name: "ready" }),
      demand: () => {
        demand++;
        return () => demand--;
      },
    },
    sync$: new Store({ link: "connected" }),
    views: {
      hold: () => {
        throw Error("No views should be opened");
      },
    },
  };
  const inspector = sourcesPanelStore(session);
  const stop = inspector.start();
  assert.equal(demand, 1);
  doc$.next(sourceDoc());
  assert.equal(inspector.store.snapshot().sources[0].name, "Usage");
  stop();
  assert.equal(demand, 0);
  assert.equal(listeners, 0);
  assert.equal(inspector.store.snapshot().sources.length, 0);
  doc$.next(sourceDoc());
  assert.equal(inspector.store.snapshot().sources.length, 0);
});
