import * as A from "@automerge/automerge/slim";
import type { Page } from "./document.ts";
import { object, requireValue, text } from "./errors.ts";

export type CommentTarget =
  | { kind: "block"; blockId: string }
  | {
      kind: "selection";
      anchor: { blockId: string; relativePositionBase64: string; textObjectId: string };
      head: { blockId: string; relativePositionBase64: string; textObjectId: string };
    };
export interface CommentMessage {
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}
export interface CommentThread {
  target: CommentTarget;
  createdAt: string;
  status: { value: "open" | "resolved"; at: string };
  messages: Record<string, CommentMessage>;
}
export const COMMENT_ACTIONS = ["add", "reply", "resolve", "reopen", "edit", "delete_message"];
const uuid = /^[a-f0-9-]{36}$/;
function check(ok: unknown, message: string): asserts ok {
  requireValue(ok, "invalid_comment", message);
}
function fields(value: object, allowed: string[], registers: string[] = []) {
  check(
    Object.keys(value).every((k) => allowed.includes(k)),
    "Unexpected comment field",
  );
  for (const key of Object.keys(value))
    if (!registers.includes(key))
      check(!A.getConflicts(value, key), "Conflicting comment structure");
}
function timestamp(value: unknown) {
  check(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Invalid comment timestamp",
  );
}
function authorOfObjectId(id: string | null): string {
  const actor = id?.split("@")[1];
  check(actor && /^[a-f0-9]{64}$/.test(actor), "Comment has no admitted author");
  return actor.slice(0, 32);
}
export function commentAuthor(value: object): string {
  return authorOfObjectId(A.getObjectId(value));
}
function statusValues(t: CommentThread): Record<string, CommentThread["status"]> {
  return (A.getConflicts(t, "status") ?? { [A.getObjectId(t.status)!]: t.status }) as Record<
    string,
    CommentThread["status"]
  >;
}
function owns(value: object, prefix: string) {
  check(commentAuthor(value) === prefix, "Only the author may change this message");
}
function immutable(before: object, after: object) {
  check(A.getObjectId(before) === A.getObjectId(after), "Comment identity cannot be replaced");
}
function endpoint(value: unknown) {
  const p = object(value);
  fields(p, ["blockId", "relativePositionBase64", "textObjectId"]);
  check(typeof p.blockId === "string" && uuid.test(p.blockId), "Invalid anchor block");
  text(p.textObjectId, "textObjectId", 256);
  const encoded = text(p.relativePositionBase64, "relativePositionBase64", 512);
  try {
    check(/^-?\d+@[a-f0-9]{64}$|^[se]$/.test(atob(encoded)), "Invalid relative position");
  } catch {
    check(false, "Invalid relative position");
  }
}
export function validateComments(doc: A.Doc<Page>, before?: A.Doc<Page>, prefix?: string) {
  if (!doc.comments) {
    check(!before?.comments, "Comments cannot be removed");
    return;
  }
  const threads = object(doc.comments);
  fields(threads, Object.keys(threads));
  check(Object.keys(threads).length <= 500, "Page exceeds 500 comment threads");
  if (before?.comments) immutable(before.comments, threads);
  for (const [id, raw] of Object.entries(threads)) {
    check(uuid.test(id), "Invalid thread ID");
    const t = object(raw) as unknown as CommentThread;
    fields(t, ["target", "createdAt", "status", "messages"], ["status"]);
    timestamp(t.createdAt);
    commentAuthor(t);
    const target = object(t.target);
    fields(target, t.target.kind === "block" ? ["kind", "blockId"] : ["kind", "anchor", "head"]);
    check(t.target.kind === "block" || t.target.kind === "selection", "Invalid comment target");
    if (t.target.kind === "block")
      check(
        typeof t.target.blockId === "string" && uuid.test(t.target.blockId),
        "Invalid target block",
      );
    else {
      endpoint(t.target.anchor);
      endpoint(t.target.head);
    }
    const statuses = statusValues(t);
    for (const [oid, status] of Object.entries(statuses)) {
      object(status);
      check(
        Object.keys(status).every((k) => ["value", "at"].includes(k)),
        "Unexpected status field",
      );
      // getConflicts materializes its map values without document handles. Use
      // their operation IDs to inspect hidden conflicts and derive authorship.
      for (const key of ["value", "at"])
        check(A.getBackend(doc).getAll(oid, key).length === 1, "Conflicting status fields");
      timestamp(status.at);
      authorOfObjectId(oid);
      check(status.value === "open" || status.value === "resolved", "Invalid thread state");
    }
    const messages = object(t.messages);
    fields(messages, Object.keys(messages));
    check(
      Object.keys(messages).length > 0 && Object.keys(messages).length <= 500,
      "Thread needs 1–500 messages",
    );
    const prior = before?.comments?.[id];
    if (prefix) {
      if (!prior) owns(t, prefix);
      else {
        immutable(prior, t);
        immutable(prior.messages, t.messages);
        check(
          prior.createdAt === t.createdAt &&
            JSON.stringify(prior.target) === JSON.stringify(t.target),
          "Thread origin cannot change",
        );
      }
      const oldStatuses = prior ? statusValues(prior) : {};
      for (const [oid, status] of Object.entries(statuses)) {
        const old = oldStatuses[oid];
        if (old)
          check(
            JSON.stringify(old) === JSON.stringify(status),
            "Status updates must create an attributed value",
          );
        else
          check(
            authorOfObjectId(oid) === prefix,
            "Status author does not match the admitted account",
          );
      }
    }
    for (const [mid, rawMessage] of Object.entries(messages)) {
      check(uuid.test(mid), "Invalid message ID");
      const m = object(rawMessage) as unknown as CommentMessage;
      fields(m, ["body", "createdAt", "editedAt", "deletedAt"], ["editedAt", "deletedAt"]);
      timestamp(m.createdAt);
      commentAuthor(m);
      text(m.body, "comment body", 16000);
      for (const key of ["editedAt", "deletedAt"] as const)
        for (const value of Object.values(A.getConflicts(m, key) ?? { current: m[key] }))
          if (value !== null) timestamp(value);
      // A concurrent body edit can arrive after deletion. Keep the text history,
      // but the tombstone always hides the message in every projection.
      const old = prior?.messages[mid];
      if (prefix) {
        if (!old) owns(m, prefix);
        else {
          immutable(old, m);
          check(old.createdAt === m.createdAt, "Message origin cannot change");
          check(
            A.getObjectId(old, "body") === A.getObjectId(m, "body"),
            "Message text identity cannot be replaced",
          );
          if (
            JSON.stringify(old) !== JSON.stringify(m) ||
            ["editedAt", "deletedAt"].some(
              (key) =>
                JSON.stringify(A.getConflicts(old, key)) !== JSON.stringify(A.getConflicts(m, key)),
            )
          )
            owns(old, prefix);
          if (old.deletedAt !== null)
            check(
              Object.values(A.getConflicts(m, "deletedAt") ?? { current: m.deletedAt }).every(
                (value) => value !== null,
              ),
              "Deleted messages cannot be restored",
            );
        }
      }
    }
    if (prior)
      for (const mid of Object.keys(prior.messages))
        check(t.messages[mid], "Use a message tombstone instead of deletion");
  }
  if (before?.comments)
    for (const id of Object.keys(before.comments))
      check(threads[id], "Thread deletion is not supported");
}

function author(value: object) {
  const id = commentAuthor(value);
  return { id, displayName: `Account ${id.slice(0, 8)}` };
}
export function selectionContext(doc: A.Doc<Page>, target: CommentTarget) {
  if (target.kind !== "selection") return undefined;
  try {
    const a = target.anchor,
      b = target.head;
    const startIndex = doc.order.indexOf(a.blockId),
      endIndex = doc.order.indexOf(b.blockId);
    if (startIndex < 0 || endIndex < startIndex) return { status: "detached" as const };
    // Replacing the source text object must never attach an old cursor to unrelated content.
    for (const p of [a, b])
      if (A.getObjectId(doc.blocks[p.blockId], "markdown") !== p.textObjectId)
        return { status: "detached" as const };
    const start = A.getCursorPosition(
      doc,
      ["blocks", a.blockId, "markdown"],
      atob(a.relativePositionBase64),
    );
    const last = A.getCursorPosition(
      doc,
      ["blocks", b.blockId, "markdown"],
      atob(b.relativePositionBase64),
    );
    // The head refers to the last selected character, not the character after
    // the range or Automerge's unbounded end sentinel. If that character was
    // deleted, stay detached rather than quoting unrelated replacement text.
    if (
      A.getCursor(doc, ["blocks", b.blockId, "markdown"], last) !== atob(b.relativePositionBase64)
    )
      return { status: "detached" as const };
    const point = doc.blocks[b.blockId].markdown.codePointAt(last);
    if (point === undefined) return { status: "detached" as const };
    const end = last + (point > 0xffff ? 2 : 1);
    if (startIndex === endIndex && end <= start) return { status: "detached" as const };
    const parts = doc.order
      .slice(startIndex, endIndex + 1)
      .map((id, i, all) =>
        doc.blocks[id].markdown.slice(i === 0 ? start : 0, i === all.length - 1 ? end : undefined),
      );
    const selected = parts.join("\n\n");
    return {
      status: "attached" as const,
      start: { blockId: a.blockId, offsetUtf16: start },
      end: { blockId: b.blockId, offsetUtf16: end },
      text: selected.slice(0, 4000),
      truncated: selected.length > 4000,
    };
  } catch {
    return { status: "detached" as const };
  }
}
export function projectComments(doc: A.Doc<Page>) {
  return Object.entries(doc.comments ?? {})
    .map(([id, t]) => ({
      id,
      author: author(t),
      createdAt: t.createdAt,
      updatedAt: [
        t.createdAt,
        t.status.at,
        ...Object.values(t.messages).flatMap((m) => [
          m.createdAt,
          m.editedAt ?? m.createdAt,
          m.deletedAt ?? m.createdAt,
        ]),
      ]
        .sort()
        .at(-1)!,
      state: t.status.value,
      ...(t.status.value === "resolved"
        ? { resolvedAt: t.status.at, resolvedBy: author(t.status) }
        : {}),
      target: JSON.parse(JSON.stringify(t.target)) as CommentTarget,
      selectionContext: selectionContext(doc, t.target),
      detached:
        t.target.kind === "block"
          ? !doc.order.includes(t.target.blockId)
          : selectionContext(doc, t.target)?.status === "detached",
      messages: Object.entries(t.messages)
        .map(([mid, m]) => ({
          id: mid,
          author: author(m),
          body: m.deletedAt ? "" : m.body,
          createdAt: m.createdAt,
          ...(m.editedAt ? { editedAt: m.editedAt } : {}),
          ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}),
          reactions: [],
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export type ProjectedThread = ReturnType<typeof projectComments>[number];

export function prepareComment(doc: A.Doc<Page>, input: Record<string, unknown>) {
  const action = text(input.action, "action", 32);
  check(COMMENT_ACTIONS.includes(action), "Unsupported comment action");
  const now = new Date().toISOString(),
    threadId = action === "add" ? crypto.randomUUID() : text(input.thread_id, "thread_id", 100);
  const messageId = action === "add" || action === "reply" ? crypto.randomUUID() : input.message_id;
  check(uuid.test(threadId), "Invalid thread ID");
  if (action === "edit" || action === "delete_message")
    check(typeof messageId === "string" && uuid.test(messageId), "Invalid message ID");
  const body =
    action === "add" || action === "reply" || action === "edit"
      ? text(input.body, "body", 16000)
      : "";
  if (["add", "reply", "edit"].includes(action)) check(body.trim(), "Comment body cannot be empty");
  let target: CommentTarget | undefined;
  if (action === "add") {
    const id = text(input.block_id, "block_id", 100);
    check(doc.order.includes(id), "Comment target not found");
    target = { kind: "block", blockId: id };
    if (input.selected_text !== undefined && input.selected_text !== null) {
      const selected = text(input.selected_text, "selected_text", 16000);
      check(selected.length > 0, "Selection cannot be empty");
      const occurrence = input.occurrence ?? 1;
      check(Number.isSafeInteger(occurrence) && Number(occurrence) > 0, "Use a 1-based occurrence");
      let index = -1;
      for (let i = 0; i < Number(occurrence); i++) {
        index = doc.blocks[id].markdown.indexOf(selected, index + 1);
        check(index >= 0, "Selected text was not found");
      }
      const point = (offset: number) => ({
        blockId: id,
        relativePositionBase64: btoa(A.getCursor(doc, ["blocks", id, "markdown"], offset)),
        textObjectId: A.getObjectId(doc.blocks[id], "markdown")!,
      });
      target = {
        kind: "selection",
        anchor: point(index),
        head: point(index + selected.length - Array.from(selected).at(-1)!.length),
      };
    }
  } else check(Object.hasOwn(doc.comments ?? {}, threadId), "Comment thread not found");
  return {
    threadId,
    messageId: typeof messageId === "string" ? messageId : null,
    apply(d: Page) {
      check(d.comments, "Comments are not initialized; reconnect");
      const message = () => ({ body, createdAt: now, editedAt: null, deletedAt: null });
      if (action === "add")
        d.comments[threadId] = {
          target: target!,
          createdAt: now,
          status: { value: "open", at: now },
          messages: { [messageId as string]: message() },
        };
      else {
        const t = d.comments[threadId];
        if (action === "reply") t.messages[messageId as string] = message();
        else if (action === "resolve" || action === "reopen")
          t.status = { value: action === "resolve" ? "resolved" : "open", at: now };
        else {
          const m = t.messages[text(messageId, "message_id", 100)];
          check(m && !m.deletedAt, "Message not found or deleted");
          if (action === "edit") {
            A.updateText(d, ["comments", threadId, "messages", messageId as string, "body"], body);
            m.editedAt = now;
          } else m.deletedAt = now;
        }
      }
    },
  };
}
