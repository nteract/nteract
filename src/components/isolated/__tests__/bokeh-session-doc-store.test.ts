import { describe, expect, it, vi } from "vite-plus/test";
import type { BokehSessionState, KeyedDocFrame } from "runtimed";
import {
  BOKEH_SESSION_DOC_KIND,
  type BokehDocChangeset,
  type BokehDocColumnRef,
  type BokehDocModel,
  type BokehDocSnapshot,
  type BokehReplicaFrameEvent,
  type BokehSessionDocReplica,
  BokehSessionDocStore,
} from "../bokeh-session-doc-store";
import type { NteractBokehDocUpdate, NteractBokehPropOrigin } from "../bokeh-session-rpc";

/** What a fake hub frame does to the replica that receives it. */
interface HubStep {
  session_id: string;
  epoch: number;
  heads: string[];
  meta?: Partial<BokehDocSnapshot["meta"]>;
  models?: Record<string, BokehDocModel>;
  props?: Record<string, Record<string, string>>;
  /** Winner of each written prop; the kernel unless given. */
  origins?: Record<string, Record<string, NteractBokehPropOrigin>>;
  removed?: string[];
  columns?: Record<string, Record<string, BokehDocColumnRef | null>>;
}

/** A routed `0x0b` frame as the sync engine's `keyedDocFrames$` emits it. */
function hubFrame(step: HubStep, kind = BOKEH_SESSION_DOC_KIND): KeyedDocFrame {
  return {
    kind,
    id: step.session_id,
    epoch: step.epoch,
    frame: new Uint8Array([0x0b, ...new TextEncoder().encode(JSON.stringify(step))]),
  };
}

function parseFrame(frame: Uint8Array): HubStep {
  return JSON.parse(new TextDecoder().decode(frame.subarray(1))) as HubStep;
}

/** Mirrors the WASM handle: an empty replica that sync fills in. */
class FakeReplica implements BokehSessionDocReplica {
  synced = false;
  readOnly = false;
  freed = false;
  heads: string[] = [];
  meta: BokehDocSnapshot["meta"] = {
    session_id: "",
    producer_name: "panel",
    producer_version: "1.9.4",
    bokeh_version: "3.9.2",
    root_ids: [],
  };
  models: Record<string, BokehDocModel> = {};
  origins = new Map<string, NteractBokehPropOrigin>();
  columns: Record<string, Record<string, BokehDocColumnRef>> = {};
  outgoing = 1;
  localWrites = 0;

  constructor(
    readonly sessionId: string,
    readonly epoch: number,
  ) {
    this.meta.session_id = sessionId;
  }

  is_synced() {
    return this.synced;
  }

  set_read_only(readOnly: boolean) {
    this.readOnly = readOnly;
  }

  receive_frame(frame: Uint8Array): BokehReplicaFrameEvent {
    const step = parseFrame(frame);
    if (step.session_id !== this.sessionId || step.epoch !== this.epoch) {
      return {
        type: "ignored",
        kind: BOKEH_SESSION_DOC_KIND,
        id: step.session_id,
        epoch: step.epoch,
      };
    }
    const changeset: BokehDocChangeset = {
      models_added: Object.keys(step.models ?? {}),
      models_removed: step.removed ?? [],
      props_changed: {},
      columns_changed: {},
      meta_changed: step.meta !== undefined,
    };
    Object.assign(this.meta, step.meta);
    Object.assign(this.models, structuredClone(step.models ?? {}));
    for (const id of step.removed ?? []) delete this.models[id];
    for (const [id, props] of Object.entries(step.props ?? {})) {
      Object.assign(this.models[id].props, props);
      changeset.props_changed[id] = Object.keys(props);
      for (const name of Object.keys(props)) {
        this.origins.set(`${id}.${name}`, step.origins?.[id]?.[name] ?? "kernel");
      }
    }
    for (const [sourceId, refs] of Object.entries(step.columns ?? {})) {
      const columns = (this.columns[sourceId] ??= {});
      for (const [name, ref] of Object.entries(refs)) {
        if (ref) columns[name] = ref;
        else delete columns[name];
      }
      changeset.columns_changed[sourceId] = Object.keys(refs);
    }
    this.synced = true;
    this.heads = step.heads;
    return { type: "applied", changed: true, changeset, reply: [9] };
  }

  flush_sync() {
    if (this.outgoing === 0) return undefined;
    this.outgoing -= 1;
    return new Uint8Array([this.epoch]);
  }

  cancel_last_flush() {}

  snapshot(): BokehDocSnapshot | null {
    if (!this.synced) return null;
    return structuredClone({
      epoch: this.epoch,
      meta: this.meta,
      models: this.models,
      columns: this.columns,
    });
  }

  get_model(modelId: string) {
    return this.models[modelId] ? structuredClone(this.models[modelId]) : null;
  }

  get_prop(modelId: string, name: string) {
    return this.models[modelId]?.props[name];
  }

  get_prop_origin(modelId: string, name: string) {
    if (this.get_prop(modelId, name) === undefined) return undefined;
    return this.origins.get(`${modelId}.${name}`) ?? "kernel";
  }

  set_props_json(patchJson: string): boolean {
    if (this.readOnly) throw new Error("Bokeh session is read-only");
    const patch = JSON.parse(patchJson) as Record<string, Record<string, string>>;
    for (const [id, props] of Object.entries(patch)) {
      for (const name of Object.keys(props)) {
        if (!this.models[id] || this.models[id].ref_props.includes(name)) {
          throw new Error(`refused ${id}.${name}`);
        }
      }
    }
    let changed = false;
    for (const [id, props] of Object.entries(patch)) {
      for (const [name, value] of Object.entries(props)) {
        changed ||= this.models[id].props[name] !== value;
        this.models[id].props[name] = value;
        this.origins.set(`${id}.${name}`, "local");
      }
    }
    if (changed) {
      this.localWrites += 1;
      this.heads = [`local-${this.localWrites}`];
      this.outgoing += 1;
    }
    return changed;
  }

  get_heads_hex() {
    return [...this.heads];
  }

  free() {
    this.freed = true;
  }
}

function record(overrides: Partial<BokehSessionState> = {}): BokehSessionState {
  return {
    output_id: "output-1",
    cell_id: "cell-1",
    execution_id: "execution-1",
    kernel_id: "kernel-1",
    status: "connected",
    producer_name: "panel",
    producer_version: "1.9.4",
    bokeh_version: "3.9.2",
    root_ids: ["root"],
    epoch: 0,
    doc_heads: ["h0"],
    ...overrides,
  };
}

const slider: BokehDocModel = {
  type: "Slider",
  ref_props: ["js_property_callbacks"],
  props: { value: "0.5", title: '"Amplitude"' },
};

function initialStep(overrides: Partial<HubStep> = {}): HubStep {
  return {
    session_id: "session-1",
    epoch: 0,
    heads: ["h0"],
    meta: { root_ids: ["root"], title: "Page" },
    models: {
      root: { type: "Column", ref_props: ["children"], props: { children: '[{"id":"slider"}]' } },
      slider,
    },
    columns: { source: { x: { blob: "x-blob", size: 10, version: 3 } } },
    ...overrides,
  };
}

function harness(options: { now?: () => number } = {}) {
  const replicas: FakeReplica[] = [];
  const sent: Uint8Array[] = [];
  const blobs = new Map<string, string>([["style-blob", '{"type":"object","name":"Style"}']]);
  const fetchBlob = vi.fn(async (ref: { blob: string }) => {
    const body = blobs.get(ref.blob);
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  });
  const store = new BokehSessionDocStore({
    createReplica: (sessionId, epoch) => {
      const replica = new FakeReplica(sessionId, epoch);
      replicas.push(replica);
      return replica;
    },
    sendFrame: async (payload) => {
      sent.push(payload);
    },
    fetchBlob,
    now: options.now,
  });
  const updates: NteractBokehDocUpdate[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, replicas, sent, blobs, fetchBlob, updates, settle };
}

describe("BokehSessionDocStore", () => {
  it("opens a replica for the RuntimeStateDoc epoch and emits the first full state", async () => {
    const { store, replicas, sent, updates, settle } = harness();
    store.updateSessions({ "session-1": record({ epoch: 2 }) });
    store.subscribe("session-1", (update) => updates.push(update));

    expect(replicas).toHaveLength(1);
    expect(replicas[0].epoch).toBe(2);
    expect(sent).toEqual([new Uint8Array([2])]);

    store.receiveFrame(hubFrame(initialStep({ epoch: 2 })));
    await settle();

    expect(sent.at(-1)).toEqual(new Uint8Array([9]));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionId: "session-1",
      epoch: 2,
      kind: "full",
      canSwitch: false,
      meta: { rootIds: ["root"], title: "Page", bokehVersion: "3.9.2", docExtras: null },
      columns: { source: { x: { version: 3, size: 10 } } },
    });
    expect(updates[0].models.slider).toEqual({
      type: "Slider",
      refProps: ["js_property_callbacks"],
      props: { value: 0.5, title: "Amplitude" },
    });
  });

  it("loads blob-backed values and decodes changed properties in deltas", async () => {
    const { store, fetchBlob, updates, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", (update) => updates.push(update));
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    store.receiveFrame(
      hubFrame({
        session_id: "session-1",
        epoch: 0,
        heads: ["h1"],
        models: { div: { type: "Div", ref_props: [], props: { text: '"new"' } } },
        props: {
          slider: {
            value: "0.75",
            stylesheets: '{"blob":"style-blob","size":32,"media_type":"application/json"}',
            title: '"Mine"',
          },
        },
        // A concurrent remote write to `title` lost to this host's value.
        origins: { slider: { title: "local" } },
        columns: { source: { x: { blob: "x2", size: 12, version: 4 }, y: null } },
      }),
    );
    await settle();

    const delta = updates[1];
    expect(delta.kind).toBe("delta");
    expect(delta.props).toEqual({
      slider: { value: 0.75, stylesheets: { type: "object", name: "Style" }, title: "Mine" },
    });
    expect(delta.propOrigins).toEqual({
      slider: { value: "kernel", stylesheets: "kernel", title: "local" },
    });
    expect(delta.models.div.props).toEqual({ text: "new" });
    expect(delta.columns).toEqual({ source: { x: { version: 4, size: 12 }, y: null } });
    expect(fetchBlob).toHaveBeenCalledWith(expect.objectContaining({ blob: "style-blob" }));
  });

  it("ignores frames for other kinds, sessions and older epochs", async () => {
    const { store, replicas, updates, settle } = harness();
    store.updateSessions({ "session-1": record({ epoch: 1 }) });
    store.subscribe("session-1", (update) => updates.push(update));

    store.receiveFrame(hubFrame(initialStep({ session_id: "other" })));
    store.receiveFrame(hubFrame(initialStep({ epoch: 0 })));
    store.receiveFrame(hubFrame(initialStep({ epoch: 1 }), "other_kind"));
    await settle();

    expect(replicas).toHaveLength(1);
    expect(replicas[0].synced).toBe(false);
    expect(updates).toEqual([]);

    store.handleResync({ kind: "other_kind", id: "session-1", epoch: 1, reason: "not mine" });
    expect(replicas).toHaveLength(1);
    expect(replicas[0].freed).toBe(false);
  });

  it("switches epochs without a reconcile when the frame showed the replaced document", async () => {
    const { store, replicas, updates, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", (update) => updates.push(update));
    store.receiveFrame(hubFrame(initialStep()));
    store.receiveFrame(
      hubFrame({
        session_id: "session-1",
        epoch: 0,
        heads: ["h1"],
        props: { slider: { value: "1" } },
      }),
    );
    await settle();

    // The daemon pushes the new epoch before RuntimeStateDoc announces it.
    store.receiveFrame(hubFrame(initialStep({ epoch: 1, heads: ["e1"] })));
    store.updateSessions({
      "session-1": record({ epoch: 1, doc_heads: ["e1"], previous_heads: ["h1"] }),
    });
    await settle();

    expect(replicas).toHaveLength(2);
    expect(replicas[0].freed).toBe(true);
    // The epoch record arrived after the new replica synced, so this full
    // update could not prove the switch.
    expect(updates.at(-1)).toMatchObject({ kind: "full", epoch: 1, canSwitch: false });

    store.updateSessions({
      "session-1": record({ epoch: 2, doc_heads: ["e2"], previous_heads: ["e1"] }),
    });
    store.receiveFrame(hubFrame(initialStep({ epoch: 2, heads: ["e2"] })));
    await settle();
    expect(updates.at(-1)).toMatchObject({ kind: "full", epoch: 2, canSwitch: true });
  });

  it("reconciles when the new epoch has changes the frame never saw", async () => {
    const { store, updates, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", (update) => updates.push(update));
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    store.updateSessions({
      "session-1": record({ epoch: 1, doc_heads: ["e1"], previous_heads: ["h-unseen"] }),
    });
    store.receiveFrame(hubFrame(initialStep({ epoch: 1, heads: ["e1"] })));
    await settle();

    expect(updates.at(-1)).toMatchObject({ kind: "full", epoch: 1, canSwitch: false });
  });

  it("writes only non-reference properties of existing models while connected", async () => {
    const { store, replicas, sent, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", () => {});
    expect(store.writeProps("session-1", { slider: { value: "0.9" } })).toEqual({
      status: "read_only",
    });
    store.receiveFrame(hubFrame(initialStep()));
    await settle();
    const sentBefore = sent.length;

    expect(
      store.writeProps("session-1", {
        slider: { value: "0.9", js_property_callbacks: "{}" },
        missing: { value: "1" },
      }),
    ).toEqual({ status: "written" });
    expect(replicas[0].models.slider.props.value).toBe("0.9");
    expect(replicas[0].models.slider.props.js_property_callbacks).toBeUndefined();
    expect(sent.length).toBe(sentBefore + 1);

    store.updateSessions({ "session-1": record({ status: "disconnected" }) });
    expect(replicas[0].readOnly).toBe(true);
    expect(store.writeProps("session-1", { slider: { value: "0.1" } })).toEqual({
      status: "read_only",
    });
  });

  it("restarts on resync and rewrites recent user values the new replica lacks", async () => {
    let now = 1_000;
    const { store, replicas, updates, settle } = harness({ now: () => now });
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", (update) => updates.push(update));
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    store.writeProps("session-1", { slider: { title: '"Old"' } });
    now = 20_000;
    store.writeProps("session-1", { slider: { value: "0.9" } });

    store.handleResync({
      kind: BOKEH_SESSION_DOC_KIND,
      id: "session-1",
      epoch: 0,
      reason: "stale epoch",
    });
    expect(replicas).toHaveLength(2);
    expect(replicas[0].freed).toBe(true);

    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    // The recent refused value is written again; the old one was likely
    // corrected by the kernel and is left alone.
    expect(replicas[1].models.slider.props.value).toBe("0.9");
    expect(replicas[1].models.slider.props.title).toBe('"Amplitude"');
    expect(updates.at(-1)).toMatchObject({ kind: "full", canSwitch: false });
    expect(updates.at(-1)?.models.slider.props.value).toBe(0.9);
  });

  it("does not rewrite values after a resync while disconnected", async () => {
    const { store, replicas, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", () => {});
    store.receiveFrame(hubFrame(initialStep()));
    await settle();
    store.writeProps("session-1", { slider: { value: "0.9" } });

    store.handleResync({
      kind: BOKEH_SESSION_DOC_KIND,
      id: "session-1",
      epoch: 0,
      reason: "session Disconnected",
    });
    store.updateSessions({ "session-1": record({ status: "disconnected" }) });
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    expect(replicas[1].models.slider.props.value).toBe("0.5");
  });

  it("drops a pending value once a remote change touched it", async () => {
    const { store, replicas, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", () => {});
    store.receiveFrame(hubFrame(initialStep()));
    await settle();
    store.writeProps("session-1", { slider: { value: "0.9" } });
    // The kernel corrected the value.
    store.receiveFrame(
      hubFrame({
        session_id: "session-1",
        epoch: 0,
        heads: ["h1"],
        props: { slider: { value: "0.8" } },
      }),
    );

    store.handleResync({
      kind: BOKEH_SESSION_DOC_KIND,
      id: "session-1",
      epoch: 0,
      reason: "foreign actor",
    });
    store.receiveFrame(hubFrame(initialStep({ props: { slider: { value: "0.8" } } })));
    await settle();

    expect(replicas[1].models.slider.props.value).toBe("0.8");
  });

  it("restarts subscriptions on a new connection and switches when nothing changed", async () => {
    const { store, replicas, sent, updates, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", (update) => updates.push(update));
    store.receiveFrame(hubFrame(initialStep()));
    await settle();
    const sentBefore = sent.length;

    store.resubscribeAll();
    expect(replicas).toHaveLength(2);
    expect(replicas[1].epoch).toBe(0);
    expect(sent.length).toBe(sentBefore + 1);

    store.receiveFrame(hubFrame(initialStep()));
    await settle();
    expect(updates.at(-1)).toMatchObject({ kind: "full", epoch: 0, canSwitch: true });
  });

  it("replays the current full state to a late subscriber", async () => {
    const { store, updates, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", () => {});
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    store.subscribe("session-1", (update) => updates.push(update));
    await settle();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ kind: "full", canSwitch: false });
  });

  it("frees the replica when the last subscriber leaves", () => {
    const { store, replicas } = harness();
    store.updateSessions({ "session-1": record() });
    const unsubscribe = store.subscribe("session-1", () => {});
    unsubscribe();
    expect(replicas[0].freed).toBe(true);
    store.receiveFrame(hubFrame(initialStep()));
    expect(replicas[0].synced).toBe(false);
  });

  it("reads column refs for data loads", async () => {
    const { store, settle } = harness();
    store.updateSessions({ "session-1": record() });
    store.subscribe("session-1", () => {});
    expect(store.columnRefs("session-1", { source: null })).toBeNull();
    store.receiveFrame(hubFrame(initialStep()));
    await settle();

    expect(store.columnRefs("session-1", { source: null, other: ["x"] })).toEqual({
      epoch: 0,
      columns: { source: { x: { blob: "x-blob", size: 10, version: 3 } }, other: {} },
    });
  });
});
