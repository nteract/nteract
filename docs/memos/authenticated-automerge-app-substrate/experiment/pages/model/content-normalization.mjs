/**
 * ONE-SHOT MIGRATION. DELETE AFTER THE PRODUCTION CONTENT MIGRATION HAS BEEN
 * APPLIED AND VERIFIED, together with worker/content-migration.mjs, both test
 * files, scripts/content-migration.mjs and the ONE-SHOT routes and flag in
 * worker/index.mjs. DEPLOYMENT.md "Content migration" lists what else goes.
 *
 * A Page document's content in the forms this build writes:
 *
 * - Every rich block body (`blocks/<id>/richText`) holds the editor's
 *   canonical spans, `encode(decode(spans).doc)` (model/wordgard-doc.mjs).
 *   Older writers stored the ProseMirror adapter's form: an explicit marker
 *   before a top-level first paragraph, a quote without its own marker, a
 *   `\n` in prose instead of a hard break, marks on code text, and markers
 *   without their default attrs.
 * - No block is Markdown-era (no `format`/`richText`); `enableRich` converts
 *   one, writing editor form.
 * - The schema stamp names every feature the content needs.
 *
 * The rewrite goes through `A.updateSpans`, so text and markers that don't
 * change keep their identity: comment anchors, cursors and node ids survive.
 * A block is refused, never written, when its decode is lossy or throws,
 * when it still holds a preserved block (the host's on-load conversion owns
 * those), when the rewrite would delete any character other than a prose
 * newline or add any text, or when it would detach a comment anchor.
 *
 * Comment message bodies are not touched: they keep the adapter form until
 * the comment length rule is decided.
 *
 * Pure: `planPageNormalization` measures on a clone and returns the writes;
 * `applyPageNormalization` replays them inside the host's change.
 */
import * as A from "@automerge/automerge/slim";
import { updateSpansConfig } from "./marks.mjs";
import { isRich, redundantFirstMarker, textPath } from "./richtext-format.mjs";
import { enableRich } from "./richtext-page.mjs";
import { decode, encode } from "./wordgard-doc.mjs";
import { selectionContext } from "./comments.mjs";
import { commentThreads } from "./comments-doc.mjs";
import { stampFeatures, stampSpans, unsupportedFeatures } from "./schema-features.mjs";
import { hasPreservedBlocks } from "./raw-migration.mjs";
import { needsCommentsMigration } from "./comments-migration.mjs";

const PRESERVED = "pages-opaque";

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Each span with its index in the text and the block type it sits in. */
function walk(spans) {
  const out = [];
  let index = 0;
  let container = null;
  for (const span of spans) {
    if (span.type === "block") {
      if (!span.value?.isEmbed) container = String(span.value?.type);
      out.push({ span, index, container });
      index += 1;
    } else {
      // A text run with no marker before it is the implicit first paragraph.
      out.push({ span, index, container: container ?? "paragraph" });
      index += span.value.length;
    }
  }
  return out;
}

/** The old forms `spans` hold, by name. */
function formsOf(spans) {
  const forms = new Set();
  if (redundantFirstMarker(spans)) forms.add("first_marker");
  for (const { span, container } of walk(spans)) {
    if (span.type !== "text") continue;
    const code = container === "code-block";
    if (!code && span.value.includes("\n")) forms.add("prose_newline");
    if (code && Object.keys(span.marks ?? {}).length) forms.add("code_marks");
  }
  return forms;
}

const count = (map, key) => {
  map[key] = (map[key] ?? 0) + 1;
};

/** The Automerge object at `path` in `doc`. */
function objectIdAt(doc, path) {
  const parent = path.slice(0, -1).reduce((value, key) => value[key], doc);
  return A.getObjectId(parent, path.at(-1));
}

/**
 * What a rewrite of the text at `path` from `before` to `after` (a
 * descendant) changed, read from the change's own operations, so every
 * character is accounted for:
 *
 * - `markers`: kept, and removed and added by type (a marker is a node id);
 * - `text`: characters `before` and `after`, `lost` (deleted), `newlines`
 *   (deleted `\n` in prose, which the editor stores as a hard break) and
 *   `unexpected` (any other deleted character).
 *
 * A sound rewrite has `unexpected: 0` and `after === before - newlines`.
 */
export function measureRewrite(before, after, path) {
  const textId = objectIdAt(before, path);
  const deleted = new Set();
  for (const change of A.getChanges(before, after))
    for (const op of A.decodeChange(change).ops)
      if (op.action === "del" && op.obj === textId && op.elemId) deleted.add(op.elemId);
  const entries = walk(A.spans(before, path));
  /** The span entry holding text index `index`. */
  const entryAt = (index) => {
    let low = 0,
      high = entries.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (entries[mid].index <= index) low = mid;
      else high = mid - 1;
    }
    return entries[low];
  };
  const markers = { kept: 0, removed: {}, added: {} };
  const text = { before: 0, after: 0, lost: 0, newlines: 0, unexpected: 0 };
  const typesBefore = {};
  for (const { span } of entries)
    if (span.type === "block") count(typesBefore, String(span.value.type));
    else text.before += span.value.length;
  for (const elemId of deleted) {
    const index = A.getCursorPosition(before, path, elemId);
    const { span, index: start, container } = entryAt(index);
    if (span.type === "block") {
      count(markers.removed, String(span.value.type));
      continue;
    }
    text.lost++;
    if (span.value[index - start] === "\n" && container !== "code-block") text.newlines++;
    else text.unexpected++;
  }
  const typesAfter = {};
  for (const span of A.spans(after, path))
    if (span.type === "block") count(typesAfter, String(span.value.type));
    else text.after += span.value.length;
  for (const [type, n] of Object.entries(typesBefore))
    markers.kept += n - (markers.removed[type] ?? 0);
  for (const [type, n] of Object.entries(typesAfter)) {
    const added = n - ((typesBefore[type] ?? 0) - (markers.removed[type] ?? 0));
    if (added > 0) markers.added[type] = added;
  }
  return { markers, text };
}

/** Selection threads on `blockId` that resolve in `before` but not `after`. */
function anchorsDetached(threads, before, after, blockId) {
  let detached = 0;
  let attached = 0;
  for (const thread of Object.values(threads)) {
    const target = thread?.target;
    if (target?.kind !== "selection" || target.anchor?.blockId !== blockId) continue;
    if (selectionContext(before, target)?.status !== "attached") continue;
    attached++;
    if (selectionContext(after, target)?.status !== "attached") detached++;
  }
  return { attached, detached };
}

const heads = (doc) => A.getHeads(doc).sort().join(",");

/**
 * Plan and measure the normalization of Page document `doc`. Pure; `doc` is
 * not changed. `commentsDoc` is the Page's comments document, used to count
 * anchors before and after.
 *
 * Returns `{ report, writes }`:
 * - `writes`: what `applyPageNormalization` replays, in order:
 *   `{ block_id, kind: "spans", spans }`, `{ block_id, kind: "enable_rich" }`
 *   and a final `{ kind: "stamps" }` when the stamp needs repair.
 * - `report`: `{ blocks, writes, refused, refused_reasons, forms,
 *   stamp_repair, preserved_blocks, comments_move_pending,
 *   unsupported_features }`. `blocked` (below) says whether apply may write.
 *   `blocks` lists every block that changes or is refused:
 *   `{ block_id, action: "normalize" | "enable_rich" | "refused", reason?,
 *   forms, markers, text, anchors }`. `forms` counts blocks by old form
 *   (`first_marker`, `quote_marker`, `prose_newline`, `code_marks`,
 *   `markdown_block`, `attrs`).
 */
export function planPageNormalization(doc, { commentsDoc } = {}) {
  const report = {
    blocks: [],
    writes: 0,
    refused: 0,
    refused_reasons: {},
    forms: {},
    stamp_repair: false,
    preserved_blocks: hasPreservedBlocks(doc),
    comments_move_pending: needsCommentsMigration(doc),
    unsupported_features: unsupportedFeatures(doc),
  };
  const writes = [];
  // The host write gate refuses these Pages anyway; plan nothing.
  if (report.unsupported_features.length) return { report, writes };
  const threads = commentThreads(commentsDoc);
  const refuse = (block_id, reason) => {
    report.blocks.push({ block_id, action: "refused", reason });
    report.refused++;
    count(report.refused_reasons, reason);
  };
  // Each step changes a clone of `work`, so the state before it stays
  // readable for measurement (a changed document's previous value is
  // outdated).
  let work = A.clone(doc);
  try {
    const ids = Object.keys(isMap(doc.blocks) ? doc.blocks : {}).sort();
    for (const id of ids) {
      const block = doc.blocks[id];
      const path = textPath(id);
      if (!isRich(block)) {
        // A block from before `kind` existed (read-content.mjs reads it as
        // Markdown) is refused on its own count, so a dry run shows whether
        // any remain; enableRich takes only Markdown blocks.
        if (block?.kind === undefined) {
          refuse(id, "kind_missing");
          continue;
        }
        if (block.kind !== "markdown") {
          refuse(id, "not_prose");
          continue;
        }
        let next;
        try {
          next = A.change(A.clone(work), (draft) => enableRich(draft, id));
        } catch {
          refuse(id, "markdown_unconvertible");
          continue;
        }
        report.blocks.push({
          block_id: id,
          action: "enable_rich",
          forms: ["markdown_block"],
          anchors: anchorsDetached(threads, work, next, id),
        });
        count(report.forms, "markdown_block");
        writes.push({ block_id: id, kind: "enable_rich" });
        A.free(work);
        work = next;
        continue;
      }
      let spans, target;
      try {
        spans = A.spans(doc, path);
        if (spans.some((s) => s.type === "block" && String(s.value?.type) === PRESERVED)) {
          refuse(id, "preserved_block");
          continue;
        }
        const decoded = decode(spans);
        if (decoded.lossy) {
          refuse(id, "lossy");
          continue;
        }
        target = encode(decoded.doc);
      } catch {
        refuse(id, "undecodable");
        continue;
      }
      const rewritten = A.change(A.clone(work), (draft) => {
        A.updateSpans(draft, path, target, updateSpansConfig);
      });
      if (heads(rewritten) === heads(work)) {
        A.free(rewritten);
        continue;
      }
      // Stamped after the comparison, so a stamp repair alone never reads as
      // a block change (the final `stamps` step reports it).
      const next = A.change(rewritten, (draft) => {
        stampSpans(draft, target);
      });
      const { markers, text } = measureRewrite(work, next, path);
      if (text.unexpected) {
        A.free(next);
        refuse(id, "identity_lost");
        continue;
      }
      if (text.after !== text.before - text.newlines) {
        A.free(next);
        refuse(id, "text_changed");
        continue;
      }
      // A rewrite never costs a comment its passage. (A Markdown-era block's
      // conversion does: its anchors name the `markdown` text, which the
      // report counts and the owner accepts.)
      const anchors = anchorsDetached(threads, work, next, id);
      if (anchors.detached) {
        A.free(next);
        refuse(id, "anchors_detached");
        continue;
      }
      const forms = formsOf(spans);
      if (markers.added.blockquote) forms.add("quote_marker");
      if (!forms.size) forms.add("attrs");
      for (const form of forms) count(report.forms, form);
      report.blocks.push({
        block_id: id,
        action: "normalize",
        forms: [...forms].sort(),
        markers,
        text,
        anchors,
      });
      writes.push({ block_id: id, kind: "spans", spans: target });
      A.free(work);
      work = next;
    }
    const stamped = A.change(A.clone(work), (draft) => {
      stampFeatures(draft);
    });
    if (heads(stamped) !== heads(work)) {
      report.stamp_repair = true;
      writes.push({ kind: "stamps" });
    }
    A.free(stamped);
  } finally {
    A.free(work);
  }
  report.writes = writes.length;
  return { report, writes };
}

/** Replay `writes` from `planPageNormalization` inside an Automerge change on
 * the document it planned. Returns the number of writes replayed. */
export function applyPageNormalization(draft, writes) {
  for (const write of writes) {
    if (write.kind === "spans") {
      A.updateSpans(draft, textPath(write.block_id), write.spans, updateSpansConfig);
      stampSpans(draft, write.spans);
    } else if (write.kind === "enable_rich") enableRich(draft, write.block_id);
  }
  // Every Page write repairs an incomplete stamp (model/page.mjs).
  stampFeatures(draft);
  return writes.length;
}

/**
 * Problems with a Page that claims to be normalized, as strings; empty when
 * it is sound: nothing left to write or refuse, no preserved block, comments
 * moved, and no feature this build lacks.
 */
export function normalizationProblems(report) {
  const problems = [];
  if (report.unsupported_features.length)
    problems.push(`unsupported features: ${report.unsupported_features.join(", ")}`);
  if (report.preserved_blocks) problems.push("preserved blocks remain");
  if (report.comments_move_pending) problems.push("comments not moved");
  for (const block of report.blocks)
    problems.push(
      block.action === "refused"
        ? `${block.block_id}: refused (${block.reason})`
        : `${block.block_id}: ${block.action} pending`,
    );
  if (report.stamp_repair) problems.push("stamp incomplete");
  return problems;
}

/** Whether a plan must not be applied: a block is refused, or the host's own
 * on-load work (preserved blocks, the comments move) isn't finished, or the
 * Page needs a feature this build lacks. The host writes nothing for a
 * blocked Page, so a run never leaves a Page half normalized. */
export const normalizationBlocked = (report) =>
  report.refused > 0 ||
  report.preserved_blocks ||
  report.comments_move_pending ||
  report.unsupported_features.length > 0;
