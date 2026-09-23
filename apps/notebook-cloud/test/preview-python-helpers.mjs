import {
  createEmptyRoomHost,
  NotebookHandle,
  RuntimeStatePeerHandle,
} from "../src/runtimed-wasm.ts";
import { FrameType, encodeTypedFrame } from "../src/protocol.ts";
export function sync(host, peer, id, scope, runtime = false, queued = []) {
  const type = runtime ? FrameType.RUNTIME_STATE_SYNC : FrameType.AUTOMERGE_SYNC;
  const flush = () => (runtime ? peer.flush_runtime_state_sync() : peer.flush_local_changes());
  const receive = (payload) =>
    host.receive_peer_frame(
      id,
      `user:dev:${id}`,
      `user:dev:${id}/test`,
      scope,
      scope === "owner",
      encodeTypedFrame(type, payload),
    );
  let outbound = [...queued];
  const initial = flush();
  if (initial) outbound.push(...receive(initial).outbound);
  outbound.push(...host.sync_peer(id, scope).outbound);
  for (let round = 0; round < 30; round++) {
    const replies = [];
    for (const frame of outbound) {
      if (frame.peer_id !== id || frame.frame_type !== type) continue;
      const received = peer.receive_frame(encodeTypedFrame(type, new Uint8Array(frame.payload)));
      for (const event of runtime ? [received] : received)
        if (event.reply) replies.push(new Uint8Array(event.reply));
    }
    const pending = flush();
    if (pending) replies.push(pending);
    if (!replies.length) return;
    outbound = replies.flatMap((payload) => receive(payload).outbound);
  }
  throw new Error("Automerge sync failed to settle");
}

export async function fixture(t, source = "print('accepted from notebook')") {
  const host = await createEmptyRoomHost("pyodide-test", "system/schema:notebook-cloud-room");
  const owner = NotebookHandle.create_bootstrap("user:dev:owner/test");
  const peer = new RuntimeStatePeerHandle("user:dev:runtime/test");
  t.after(() => {
    peer.free();
    owner.free();
    host.free();
  });
  sync(host, owner, "owner", "owner");
  owner.add_cell(0, "code", "code");
  owner.update_source("code", source);
  sync(host, owner, "owner", "owner");
  const request = (scope = "owner") =>
    host.receive_peer_frame(
      scope,
      `user:dev:${scope}`,
      `user:dev:${scope}/test`,
      scope,
      scope === "owner",
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: crypto.randomUUID(), action: "execute_cell", cell_id: "code" }),
        ),
      ),
    );
  const accepted = request();
  sync(host, owner, "owner", "owner", false, accepted.outbound);
  // Later edits must not silently replace the source the room accepted.
  owner.update_source("code", "print('edited after submission')");
  sync(host, owner, "owner", "owner");
  sync(host, peer, "runtime", "runtime_peer", true);
  return {
    host,
    peer,
    request,
    publish: async () => sync(host, peer, "runtime", "runtime_peer", true),
  };
}
