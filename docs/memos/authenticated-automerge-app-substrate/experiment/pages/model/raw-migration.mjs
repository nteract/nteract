// Conversion of preserved Markdown blocks (`pages-opaque`, ProseMirror `raw`)
// to native rich text.
//
// Older builds stored Markdown they couldn't import as one read-only block
// holding its source. This build imports every construct natively or as
// literal text, so each stored block re-parses its source in place: the block
// marker is replaced by the spans `parseMarkdown` produces, nested under the
// marker's own parents. Text around the marker keeps its characters, so
// comment anchors and concurrent edits nearby survive.
//
// One writer: the Page host. Two peers that each replaced the same marker
// would each insert a copy, and Automerge keeps both insertions. The host is
// a single serialized writer per Page, so it converts on load, before native
// connections open, and after creating or registering a Page. Its change runs
// through the operation journal, so a restart replays the recorded bytes
// rather than converting again. Browsers never convert; they show a
// preserved block read-only until the host's change arrives.
//
// The same change stamps `preserved-markdown-converted`. A build without that
// feature (every build that could still write or convert a preserved block,
// such as a stale tab's table conversion) opens the Page read-only, and the
// host refuses its native writes, so no second conversion reaches the Page.
//
// Idempotent: a converted text holds no preserved marker, so running again
// finds nothing and changes nothing.
import * as A from "@automerge/automerge/slim";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { updateSpansConfig } from "./marks.mjs";
import { adapter, isRich, parseMarkdown } from "./richtext.mjs";
import { documentFeatures, stampFeatures, stampSpans } from "./schema-features.mjs";

export const PRESERVED_BLOCK = "pages-opaque";
export const CONVERSION_FEATURE = "preserved-markdown-converted";

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPreserved = (span) => span.type === "block" && String(span.value?.type) === PRESERVED_BLOCK;

// Every rich text object a Page holds: block bodies and comment messages.
function richTextPaths(doc) {
  const paths = [];
  for (const [id, block] of Object.entries(isMap(doc?.blocks) ? doc.blocks : {}))
    if (isRich(block)) paths.push(["blocks", id, "richText"]);
  for (const [threadId, thread] of Object.entries(isMap(doc?.comments) ? doc.comments : {}))
    for (const [messageId, message] of Object.entries(
      isMap(thread?.messages) ? thread.messages : {},
    ))
      if (isRich(message)) paths.push(["comments", threadId, "messages", messageId, "richText"]);
  return paths;
}

function spansAt(doc, path) {
  try {
    return A.spans(doc, path);
  } catch {
    return [];
  }
}

/** Paths of rich texts in `doc` that still hold a preserved block. */
export function preservedTextPaths(doc) {
  return richTextPaths(doc).filter((path) => spansAt(doc, path).some(isPreserved));
}

export const hasPreservedBlocks = (doc) => preservedTextPaths(doc).length > 0;

const immutable = (value) => (typeof value === "string" ? new A.ImmutableString(value) : value);
const plain = (value) => (A.isImmutableString(value) ? String(value) : value);

/** The native spans that replace one preserved marker. Its source parses as
 * Markdown (math and HTML stay literal text), or as plain text when its kind
 * is not Markdown, and every block lands under the marker's parents. */
export function convertedSpans(marker) {
  const attrs = marker.value.attrs ?? {};
  const parents = (marker.value.parents ?? []).map(plain);
  const spans = pmNodeToSpans(
    adapter,
    parseMarkdown(String(plain(attrs.source) ?? ""), {
      kind: String(plain(attrs.kind) ?? "markdown"),
    }),
  );
  // The marker was a block boundary. An implicit first paragraph needs its
  // own marker here, or its text would join the block before it.
  if (spans[0]?.type !== "block" || spans[0].value.isEmbed)
    spans.unshift({
      type: "block",
      value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false },
    });
  return spans.map((span) =>
    span.type !== "block"
      ? span
      : {
          type: "block",
          value: {
            ...span.value,
            type: immutable(String(span.value.type)),
            parents: [...parents, ...span.value.parents.map(String)].map(immutable),
            attrs: Object.fromEntries(
              Object.entries(span.value.attrs ?? {}).map(([key, value]) => [
                key,
                immutable(plain(value)),
              ]),
            ),
          },
        },
  );
}

// The element ids of every preserved marker `doc` holds. A marker's cursor
// is its element id, which is also the id of its map object.
function preservedMarkerIds(doc) {
  const ids = new Set();
  for (const path of preservedTextPaths(doc)) {
    let index = 0;
    for (const span of spansAt(doc, path)) {
      if (isPreserved(span)) ids.add(A.getCursor(doc, path, index));
      index += span.type === "block" ? 1 : span.value.length;
    }
  }
  return ids;
}

// The element ids of every marker any change in `doc` created: the object a
// change sets `type: "pages-opaque"` on.
function createdMarkerIds(doc) {
  const ids = new Set();
  for (const change of A.getAllChanges(doc))
    for (const op of A.decodeChange(change).ops)
      if (op.key === "type" && op.value === PRESERVED_BLOCK) ids.add(op.obj);
  return ids;
}

/**
 * Changes after `since` that rewrite, retype or delete a preserved block,
 * other than the host's own conversion, and the heads of `doc` without them.
 * Returns `{ baseHeads, changes }`, or null when there are none.
 *
 * Only a build from before the conversion writes such a change (its Edit
 * table action, or deleting the block). The host converts every preserved
 * block itself, and Automerge keeps both conversions, so publishing one
 * would hold the block's content twice. `since` is history the host already
 * has; pass [] when that is unknown, which reads the whole history.
 *
 * The host's conversion is told apart by its stamp: the conversion feature
 * is set in the same change. Everything that depends on a selected change
 * is left out of `baseHeads` too, so the history there is closed.
 */
export function preservedBlockEdits(doc, since = []) {
  const metas = A.getChangesSince(doc, since).map((change) => A.decodeChange(change));
  if (!metas.length) return null;
  const markers = since.length ? preservedMarkerIds(A.view(doc, since)) : createdMarkerIds(doc);
  if (!markers.size) return null;
  const touched = new Set();
  for (const meta of metas) {
    // The change that creates a marker writes its fields too.
    const created = new Set(
      meta.ops
        .filter((op) => op.key === "type" && op.value === PRESERVED_BLOCK)
        .map((op) => op.obj),
    );
    const touches = meta.ops.some(
      (op) =>
        (markers.has(op.obj) && !created.has(op.obj)) ||
        (op.action === "del" && markers.has(op.elemId)),
    );
    if (touches && !documentFeatures(A.view(doc, [meta.hash])).includes(CONVERSION_FEATURE))
      touched.add(meta.hash);
  }
  if (!touched.size) return null;
  // Dependents of a selected change go with it.
  const left = new Set(touched);
  for (let grew = true; grew; ) {
    grew = false;
    for (const meta of metas)
      if (!left.has(meta.hash) && meta.deps.some((dep) => left.has(dep))) {
        left.add(meta.hash);
        grew = true;
      }
  }
  const kept = metas.filter((meta) => !left.has(meta.hash));
  const covered = new Set(kept.flatMap((meta) => meta.deps));
  const baseHeads = [...new Set([...since, ...kept.map((meta) => meta.hash)])].filter(
    (head) => !covered.has(head),
  );
  return { baseHeads, changes: [...touched] };
}

/**
 * Convert every preserved block in `doc` inside an Automerge change. Returns
 * the number of converted blocks; zero means the change wrote nothing. Stamps
 * the features the new spans need, and the conversion feature when it
 * converted anything.
 */
export function convertPreservedBlocks(doc) {
  let converted = 0;
  for (const path of preservedTextPaths(doc)) {
    const spans = spansAt(doc, path).flatMap((span) => {
      if (!isPreserved(span)) return [span];
      converted++;
      return convertedSpans(span);
    });
    A.updateSpans(doc, path, spans, updateSpansConfig);
    stampSpans(doc, spans);
  }
  if (converted) stampFeatures(doc, [CONVERSION_FEATURE]);
  return converted;
}
