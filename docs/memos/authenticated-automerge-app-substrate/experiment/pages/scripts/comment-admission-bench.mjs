// Per-record cost of native comment admission (worker/comment-admission.mjs):
// one reply checked against a comments document of growing size. Prints the
// clone alone and the whole admitCommentChanges call, averaged over 20 runs.
//
//   npx tsx scripts/comment-admission-bench.mjs
import * as A from "@automerge/automerge";
import { admitCommentChanges } from "../model/comment-authority.mjs";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
const page = A.from({ blocks: { b1: { id: "b1", markdown: "One" } } });
const who = { principal: "account:bob", displayName: "Bob", driver: "Browser" };
for (const threads of [100, 1000, 3000]) {
  let doc = A.clone(commentsGenesis("c0000000-0000-4000-8000-000000000009"));
  const ids = [];
  for (let i = 0; i < threads; i += 50)
    doc = A.change(doc, (d) => {
      for (let j = 0; j < 50; j++) {
        const r = applyComment(
          d,
          { block_id: "b1", body: "Thread body " + i + j },
          who,
          undefined,
          { page, role: "commenter" },
        );
        ids.push(r.thread_id);
        applyComment(
          d,
          { action: "reply", thread_id: r.thread_id, body: "reply" },
          who,
          undefined,
          { page, role: "commenter" },
        );
      }
    });
  const bytes = A.save(doc).length;
  const runs = 20;
  let clone = 0,
    admit = 0;
  for (let r = 0; r < runs; r++) {
    const fork = A.clone(doc, { actor: "ab".repeat(16) });
    const next = A.change(fork, (d) =>
      applyComment(d, { action: "reply", thread_id: ids[r], body: "new" }, who, undefined, {
        page,
        role: "commenter",
      }),
    );
    const changes = A.getChanges(doc, next);
    let t = performance.now();
    const c = A.clone(doc);
    clone += performance.now() - t;
    A.free(c);
    t = performance.now();
    const res = admitCommentChanges(doc, changes, who.principal, { role: "commenter" });
    admit += performance.now() - t;
    if (!res.ok) throw Error(JSON.stringify(res.reason));
    A.free(res.next);
  }
  console.log(
    JSON.stringify({
      threads,
      messages: threads * 2,
      savedKiB: Math.round(bytes / 1024),
      cloneMs: +(clone / runs).toFixed(2),
      admitMs: +(admit / runs).toFixed(2),
    }),
  );
}
