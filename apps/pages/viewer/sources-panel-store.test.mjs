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
  sourcePlacements,
} from "./sources-panel-store.mjs";
import { createPageData, initializePage, applyPageOperation } from "../model/page.mjs";

function pageWithViews() {
  return A.change(
    A.from(createPageData({ pageId: crypto.randomUUID(), title: "Sources" })),
    (draft) => {
      initializePage(draft, "An introduction", "intro");
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            {
              op: "insert_node",
              node: {
                type: "dataframe",
                attrs: {
                  binding: { source_id: "usage" },
                  media_type: "application/vnd.apache.parquet",
                  title: "Data",
                },
              },
            },
            { op: "insert_node", node: { type: "view", attrs: { view_id: "chart" } } },
            { op: "insert_node", node: { type: "view", attrs: { view_id: "chart" } } },
          ],
        },
      });
    },
  );
}
test("native placements retain marker identity after prose changes and repeated views", () => {
  const doc = pageWithViews();
  const before = sourcePlacements(doc);
  assert.equal(before.unreadableBlocks, 0);
  assert.equal(before.placements.length, 3);
  assert.deepEqual(before.placements[0].binding, { source_id: "usage" });
  assert.equal(new Set(before.placements.map((p) => p.key)).size, 3);
  assert.match(before.placements[0].key, /^[0-9]+@[0-9a-f]+$/);
  const edited = A.change(doc, (draft) =>
    A.splice(draft, ["blocks", "intro", "richText"], 1, 0, "Extra "),
  );
  assert.deepEqual(sourcePlacements(edited), before);
});
test("view demand is shared by placements, follows updates and releases on removal", () => {
  let doc = pageWithViews();
  const listeners = new Set();
  const state$ = new BehaviorSubject({ status: "pending" });
  let held = 0,
    released = 0;
  const session = {
    get doc() {
      return doc;
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sources: {
      doc$: new BehaviorSubject(sourceDoc()),
      state$: new Store({ name: "ready" }),
      demand: () => () => {},
    },
    sync$: new Store({ link: "connected" }),
    views: {
      hold: (id) => {
        assert.equal(id, "chart");
        held++;
        return { view$: state$, release: () => released++ };
      },
    },
  };
  const inspector = sourcesPanelStore(session),
    stop = inspector.start();
  assert.equal(held, 1);
  assert.equal(inspector.store.snapshot().unresolvedViews.length, 2);
  state$.next({
    status: "ready",
    view: {
      title: "Chart",
      media_type: "application/vnd.vegalite.v6+json",
      revision: "1",
      data: { rows: { source_id: "usage" } },
    },
  });
  assert.equal(inspector.store.snapshot().sources[0].uses.length, 3);
  doc = A.change(doc, (draft) => {
    for (const p of sourcePlacements(doc).placements.filter((p) => p.kind === "view"))
      delete draft.blocks[p.blockId];
  });
  for (const fn of listeners) fn();
  assert.equal(released, 1);
  assert.equal(inspector.store.snapshot().sources[0].uses.length, 1);
  state$.next({ status: "pending" });
  assert.equal(inspector.store.snapshot().unresolvedViews.length, 0);
  stop();
  assert.equal(listeners.size, 0);
});

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
  assert.equal(result.sources.find((s) => s.source_id === "renderer").availability, "missing");
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
  for (const name of ["unreadable", "unserved"]) {
    session.sources.state$.update(() => ({ name }));
    assert.equal(inspector.store.snapshot().answer, name);
  }
  session.sources.state$.update(() => ({ name: "ready" }));
  assert.equal(inspector.store.snapshot().answer, "known");
  doc$.next(sourceDoc());
  assert.equal(inspector.store.snapshot().sources[0].name, "Usage");
  stop();
  assert.equal(demand, 0);
  assert.equal(listeners, 0);
  assert.equal(inspector.store.snapshot().sources.length, 0);
  doc$.next(sourceDoc());
  assert.equal(inspector.store.snapshot().sources.length, 0);
});

test("unreadable source metadata stays distinct from an absent source", () => {
  const doc = A.change(sourceDoc(), (draft) => {
    draft.sources.usage.name = 42;
  });
  const result = projectSourcesPanel(
    doc,
    {
      unreadableBlocks: 0,
      placements: [
        { key: "table", kind: "dataframe", binding: { source_id: "usage" } },
        { key: "missing", kind: "dataframe", binding: { source_id: "absent" } },
      ],
    },
    {},
  );
  assert.equal(result.unreadableSources, 1);
  const unreadable = result.sources.find((source) => source.source_id === "usage");
  assert.equal(unreadable.availability, "unreadable");
  assert.equal(unreadable.uses.length, 1);
  assert.equal(
    result.sources.find((source) => source.source_id === "absent").availability,
    "missing",
  );
});
