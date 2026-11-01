// Native transaction/selection approach adapted from rgbkrk/wordgard-automerge
// c9c6ea8 (BSD-3-Clause). See WORDGARD-NOTICE for attribution.
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as A from "@automerge/automerge/slim";
import { Wordgard, Decoration, KeyBinding } from "wordgard/editor";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import {
  Command,
  toggleMark,
  setTextblockType,
  toggleList,
  listIsActive,
  canAddMarkInRange,
} from "wordgard/command";
import { history, undo, redo, undoDepth, redoDepth } from "wordgard/history";
import { tables } from "wordgard/table";
import { insertTable, tablePresentation, tableKeys, selectedTable } from "./wordgard-tables.mjs";
import { TableMenu } from "./TableMenu.jsx";
import { CODE_LANGUAGES, codeHighlighting } from "./code-highlight.mjs";
import { MobileBar } from "./MobileBar.jsx";
import { MOBILE_EDITOR_QUERY } from "./visual-viewport.mjs";
import {
  resolveUploadPreview,
  setUploadPreview,
  uploadPreview,
  uploadPreviews,
} from "./upload-preview.mjs";
import { HighlightMenu } from "./HighlightMenu.jsx";
import { monotonicNow } from "./monotonic.mjs";
import { selectionHighlight, toggleHighlight } from "./highlight.mjs";
import {
  blockDoc,
  paragraph,
  heading,
  lineBreak,
  strong,
  emphasis,
  code,
  codeBlock,
  codeBlockLanguage,
  bulletList,
  orderedList,
  blockquote,
} from "wordgard/schema";
import {
  Paragraph,
  Heading,
  Strong,
  Emphasis,
  Code,
  CodeBlock,
  BulletList,
  OrderedList,
} from "wordgard/types";
import {
  Bold,
  Italic,
  Code as CodeIcon,
  List,
  ListOrdered,
  ListTodo,
  Undo2,
  Redo2,
  MessageSquare,
  Link as LinkIcon,
  ImagePlus,
} from "lucide-react";
import {
  commitEditorTransactions,
  createWordgardBinding,
  wordgardCodeNewlines,
  insertPlainLineBreak,
  remoteEditorPosition,
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { PagesLink, TaskList, elements } from "./wordgard-model.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
import { markdownShortcuts } from "./wordgard-shortcuts.mjs";
import { clickBelowFinalBlock, exitBlock, leaveFinalBlock } from "./wordgard-leave-block.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import {
  createWordgardCollaboration,
  publishWordgardSelection,
  wordgardCommentSelection,
} from "./wordgard-collaboration.mjs";
import { wordgardWidgets, wordgardCodeLanguages } from "./wordgard-widgets.mjs";
import { selectionToolbarPosition } from "./selection-toolbar.mjs";
import { linkDestination } from "./link-destination.mjs";
import { LinkPopover } from "./LinkPopover.jsx";
import { selectedImage } from "./image-selection.mjs";
import { normalizePastedHTML } from "./clipboard-html.mjs";
import {
  IMAGE_ACCEPT,
  captureImageInsertion,
  createImageUploader,
  imageFiles,
  resolveImageInsertion,
} from "./image-upload.mjs";
import "./wordgard.css";

const styles = [
  ["p", "Paragraph"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["code", "Code block"],
];
// Toolbar order, by how often each is reached for: history, the text style,
// marks (the highlight menu follows inline code), lists, then the insert
// actions (table, image) at the far end. Comment always ends the bar.
const historyControls = [
  ["undo", "Undo", Undo2],
  ["redo", "Redo", Redo2],
];
const markControls = [
  ["bold", "Bold", Bold],
  ["italic", "Italic", Italic],
  ["link", "Link", LinkIcon],
  ["code", "Inline code", CodeIcon],
];
const listControls = [
  ["bullet", "Bulleted list", List],
  ["ordered", "Numbered list", ListOrdered],
  ["task", "Task list", ListTodo],
];
const commentControl = ["comment", "Comment on selection", MessageSquare];
// Link and Comment act on a selection; they aren't toggles.
const actions = new Set(["link", "comment"]);
const marks = { bold: Strong, italic: Emphasis, code: Code };
const remoteAnnotations = () => [Transaction.remote.of(true), Transaction.addToHistory.of(false)];
const editConfig = (editable) => [
  GardState.readOnly.of(!editable),
  Wordgard.editable.of(editable),
  codeBlockLanguage(),
  ...(editable ? wordgardCodeLanguages(CODE_LANGUAGES) : []),
];

// A pending upload is on screen when the editor draws its inline preview.
// The preview clears itself when its insertion point is deleted; the status
// row, with Cancel, then shows again.
const previewShown = (editor) => !!editor?.state.field(uploadPreview, false);

export function WordgardEditor(props) {
  const {
    replica,
    id,
    editable,
    toolbarHost,
    toolbarOpen = false,
    threads,
    commentTarget,
    commentDraft,
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const mount = useRef(null),
    caretLayer = useRef(null),
    view = useRef(null),
    binding = useRef(null),
    collaboration = useRef(null),
    toolbar = useRef(null),
    imageInput = useRef(null),
    imageUploader = useRef(null),
    imageTarget = useRef(null);
  const permissions = useRef(new GardState.Compartment());
  const [format, setFormat] = useState(null),
    [floating, setFloating] = useState(null),
    [contextualToolbar, setContextualToolbar] = useState(false),
    [remoteCarets, setRemoteCarets] = useState([]),
    [link, setLink] = useState(null),
    [editingLink, setEditingLink] = useState(false),
    [imageStatus, setImageStatus] = useState(null),
    [mobile, setMobile] = useState(() => matchMedia(MOBILE_EDITOR_QUERY).matches),
    [barFocus, setBarFocus] = useState(false);
  const mobileBar = useRef(null);
  const [generation, reset] = useState(0);
  const pendingLink = useRef(null),
    refresh = useRef(() => {}),
    positionToolbar = useRef(() => {});
  const report = (error) =>
    latest.current.onError(error instanceof Error ? error.message : String(error));
  function comment() {
    const editor = view.current;
    if (!editor || !latest.current.editable) return false;
    const selected = wordgardCommentSelection(replica, id, editor, binding.current.current.map);
    if (!selected) return false;
    latest.current.onComment?.(selected);
    return true;
  }
  function openLink(position) {
    const editor = view.current,
      current = binding.current.current,
      native = replica.doc;
    if (!editor) return;
    const path = ["blocks", id, "richText"],
      selection = editor.state.selection;
    let from = current.map.wgToAm[selection.from],
      to = current.map.wgToAm[selection.to];
    const at = current.map.wgToAm[position ?? selection.head];
    const existing = A.marks(native, path).find(
      (mark) => mark.name === "link" && mark.start <= at && mark.end >= at,
    );
    if (existing) {
      from = existing.start;
      to = existing.end;
    }
    if (to <= from || from === undefined || to === undefined) return;
    const text = native.blocks[id].richText.slice(from, to),
      width = [...text].at(-1)?.length;
    if (!width) return;
    let attrs = { href: "", title: null };
    if (existing) {
      try {
        attrs = JSON.parse(existing.value);
      } catch {
        return;
      }
    }
    pendingLink.current = {
      first: A.getCursor(native, path, from, "after"),
      last: A.getCursor(native, path, to - width, "before"),
      width,
      object: A.getObjectId(native.blocks[id], "richText"),
      attrs,
      existing: !!existing,
    };
    setLink({ from: current.map.amToWg[from], to: current.map.amToWg[to], attrs });
    setEditingLink(!existing);
  }
  function changeLink(href) {
    if (!latest.current.editable || !pendingLink.current) return false;
    const saved = pendingLink.current,
      native = replica.doc,
      path = ["blocks", id, "richText"];
    if (A.getObjectId(native.blocks[id], "richText") !== saved.object)
      throw Error("The link passage was replaced. Select it again.");
    const from = A.getCursorPosition(native, path, saved.first),
      last = A.getCursorPosition(native, path, saved.last);
    if (
      A.getCursor(native, path, from, "after") !== saved.first ||
      A.getCursor(native, path, last, "before") !== saved.last ||
      last < from
    )
      throw Error("The link passage was removed. Select it again.");
    if (href !== null && !linkDestination(href, location.href))
      throw Error("Use a valid http, https, mailto, or relative link.");
    const editor = view.current,
      map = binding.current.current.map;
    const start = map.amToWg[from],
      end = map.amToWg[last + saved.width];
    if (!editor || start === undefined || end === undefined)
      throw Error("The link passage is no longer visible. Select it again.");
    // Keep native cursor validation, then use the editor transaction so link
    // changes participate in the same local undo history as typing.
    editor.dispatch({
      changes: {
        from: start,
        to: end,
        ...(href === null
          ? { remove: PagesLink.of(saved.attrs) }
          : { add: PagesLink.of({ ...saved.attrs, href }) }),
      },
      userEvent: "input.link",
      annotations: history.isolate.of(true),
    });
    return true;
  }
  useEffect(() => {
    if (!mount.current || !replica.doc?.blocks[id]) return;
    setLink(null);
    pendingLink.current = null;
    let alive = true,
      writing = false,
      lastPresence = "",
      lastPresenceAt = 0;
    const bound = createWordgardBinding(replica, id);
    binding.current = bound;
    const undoHistory = wordgardHistory();
    const collab = createWordgardCollaboration({
      replica,
      id,
      getEditor: () => editor,
      getCurrent: () => bound.current,
      getThreads: () => latest.current.threads ?? [],
      getTarget: () => latest.current.commentTarget,
      getDraft: () => latest.current.commentDraft,
    });
    collaboration.current = collab;
    const acceptImages = (files, position) => {
      if (!files.length) return false;
      if (!latest.current.editable || replica.canWrite === false) {
        setImageStatus({
          pending: false,
          message: "You need edit access to add images.",
          retryable: false,
        });
        return true;
      }
      try {
        const target = captureImageInsertion(replica, id, editor, bound.current.map, position);
        imageUploader.current?.start(files, target);
      } catch (error) {
        setImageStatus({ pending: false, message: error.message, retryable: false });
      }
      return true;
    };
    const editor = Wordgard.create({
      parent: mount.current,
      doc: bound.current.doc,
      config: [
        blockDoc(),
        paragraph(),
        heading(),
        lineBreak(),
        strong(),
        emphasis(),
        code(),
        bulletList(),
        orderedList(),
        taskLists(),
        blockquote(),
        codeBlock(),
        markdownShortcuts(),
        tables({ cellContent: "inline", cellSpanning: false }),
        tablePresentation,
        tableKeys,
        GardState.schemaElement.of(elements),
        Decoration.Mark.shape(PagesLink, {
          element: "a",
          attributes: (value) => {
            try {
              const attrs = value;
              const href = linkDestination(attrs.href, location.href);
              return href
                ? { href, title: attrs.title ?? "", target: "_blank", rel: "noopener noreferrer" }
                : {};
            } catch {
              return {};
            }
          },
        }),
        wordgardWidgets(),
        wordgardCodeNewlines,
        wordgardListStarts,
        codeHighlighting,
        uploadPreviews,
        undoHistory.extension,
        permissions.current.of(editConfig(latest.current.editable)),
        Wordgard.clipboardInputHTMLFilter.of((html) => normalizePastedHTML(html)),
        Wordgard.domEventHandler("paste", (event) => acceptImages(imageFiles(event.clipboardData))),
        Wordgard.domEventHandler("drop", (event) => {
          const files = imageFiles(event.dataTransfer);
          if (!files.length) return false;
          return acceptImages(
            files,
            editor.posAtCoords({ x: event.clientX, y: event.clientY }).pos,
          );
        }),
        KeyBinding.of({
          key: "Mod-k",
          run: () => {
            openLink();
            return true;
          },
        }),
        KeyBinding.of({ key: "Mod-Alt-m", run: () => comment() }),
        KeyBinding.of({ key: "Shift-Enter", run: insertPlainLineBreak }),
        KeyBinding.of({ key: "Mod-Enter", run: exitBlock, allowDefault: true }),
        KeyBinding.of({ key: "ArrowDown", run: leaveFinalBlock, allowDefault: true }),
        Wordgard.domEventHandler("mousedown", (event) => clickBelowFinalBlock(editor, event)),
        KeyBinding.of({
          key: "Mod-Shift-h",
          run: () => latest.current.editable && Command.dispatch(editor, toggleHighlight),
        }),
        Wordgard.contentAttributes.of({ "aria-label": "Document text", spellcheck: "true" }),
        // On phones the compact bar and the header cover the visual viewport's
        // edges; keep the caret clear of both when scrolling it into view.
        Wordgard.coveredMargins.of(() => {
          const bar = mobileBar.current?.getBoundingClientRect();
          // The pinned toolbar and the reload banner stick below the header.
          const header = document.querySelector(".app-header")?.getBoundingClientRect();
          const stack = document.querySelector(".status-stack")?.getBoundingClientRect();
          const covered = Math.max(header?.bottom ?? 0, stack?.bottom ?? 0);
          const viewport = window.visualViewport;
          const bottomEdge = viewport ? viewport.offsetTop + viewport.height : innerHeight;
          return {
            top: Math.max(0, covered - (viewport?.offsetTop ?? 0)),
            bottom: bar ? Math.max(0, bottomEdge - bar.top) : 0,
          };
        }),
        // Wordgard 0.6.2's scrollTo shrinks the caret's rect by the covered
        // margins where it should grow it, so with any covered margin the
        // caret can stop under the header or the bar; margins taller than a
        // line flip the rect and skip the scroll entirely. Desktop's header
        // has the same bug. On phones, scroll the caret between the header
        // and the bar here first; Wordgard's own pass then finds it in view
        // and only handles horizontal scrolling. This handler can go once
        // Wordgard grows the rect by the margins.
        Wordgard.scrollHandler.of((wg, target) => {
          if (target.spec.y !== "nearest" || !matchMedia(MOBILE_EDITOR_QUERY).matches) return false;
          const start = wg.coordsAtPos(target.from, target.from === target.to ? target.assoc : 1);
          const end = target.from === target.to ? start : wg.coordsAtPos(target.to, -1);
          if (!start || !end) return false;
          const margins = wg.getScrollMargins();
          const viewport = window.visualViewport;
          const visibleTop = (viewport?.offsetTop ?? 0) + margins.top;
          const visibleBottom =
            (viewport ? viewport.offsetTop + viewport.height : innerHeight) - margins.bottom;
          const top = Math.min(start.top, end.top),
            bottom = Math.max(start.bottom, end.bottom),
            margin = target.spec.yMargin ?? 5;
          if (top < visibleTop) window.scrollBy(0, top - visibleTop - margin);
          else if (bottom > visibleBottom) window.scrollBy(0, bottom - visibleBottom + margin);
          return false;
        }),
        Wordgard.exceptionSink.of(report),
        Wordgard.transactionListener.of((transactions) => {
          if (!alive) return;
          writing = true;
          try {
            commitEditorTransactions(editor, bound, transactions, {
              annotations: remoteAnnotations(),
              undoHistory,
            });
          } catch (error) {
            report(error);
          } finally {
            writing = false;
          }
          // The local write is in Automerge now: put a pending upload preview
          // back on its native cursor, exactly where the image will land.
          if (transactions.some((tr) => tr.docChanged) && editor.state.field(uploadPreview))
            queueMicrotask(() => {
              if (alive && editor.state.field(uploadPreview))
                editor.dispatch({
                  effects: resolveUploadPreview.of(null),
                  annotations: Transaction.addToHistory.of(false),
                });
            });
        }),
        Wordgard.updateListener.of(() => refresh.current()),
        Decoration.Range.source.of(() => collab.ranges()),
      ],
    });
    view.current = editor;
    setImageStatus(null);
    imageTarget.current = null;
    const uploader = createImageUploader({
      replica,
      getEditor: () => editor,
      getMap: () => bound.current.map,
      isCurrent: () =>
        alive &&
        view.current === editor &&
        binding.current === bound &&
        latest.current.replica === replica &&
        latest.current.id === id &&
        latest.current.editable,
      onState: (state) => {
        setImageStatus(state);
        if (view.current !== editor) return;
        // Draw the pending upload inline where the image will land. If the
        // insertion point can't be resolved, the status row stays as the fallback.
        let preview = null;
        if (state?.pending && state.target) {
          const target = state.target;
          preview = {
            // The binding updates its map before the editor sees a change.
            resolve: () => resolveImageInsertion(replica, target, bound.current.map),
            src: state.preview ?? "",
            name: state.name ?? "",
            onCancel: () => uploader.cancel(),
          };
          try {
            preview.resolve();
          } catch {
            preview = null;
          }
        }
        if (preview || editor.state.field(uploadPreview))
          editor.dispatch({
            effects: setUploadPreview.of(preview),
            annotations: Transaction.addToHistory.of(false),
          });
      },
    });
    imageUploader.current = uploader;
    editor.dom.classList.add("wordgard-document");
    let caretFrame = null,
      beatTimer;
    const measureCarets = () => {
      if (!alive || caretFrame !== null) return;
      caretFrame = requestAnimationFrame(() => {
        caretFrame = null;
        if (!alive || !caretLayer.current) return;
        const origin = caretLayer.current.getBoundingClientRect();
        const bounds = editor.contentDOM.getBoundingClientRect();
        const visibleTop = Math.max(0, bounds.top),
          visibleBottom = Math.min(innerHeight, bounds.bottom);
        const next = collab.carets().flatMap((peer) => {
          try {
            if (peer.type === "dot")
              return [{ ...peer, left: bounds.right - origin.left, top: bounds.top - origin.top }];
            if (peer.type === "bar") {
              const first = editor.coordsAtPos(peer.from),
                last = editor.coordsAtPos(peer.to);
              if (last.bottom < visibleTop || first.top > visibleBottom) return [];
              return [
                {
                  ...peer,
                  left: bounds.left - origin.left,
                  top: first.top - origin.top,
                  height: Math.max(last.bottom - first.top, first.bottom - first.top),
                },
              ];
            }
            const rect = editor.coordsAtPos(peer.position);
            const visibleLeft = Math.max(0, bounds.left),
              visibleRight = Math.min(innerWidth, bounds.right),
              labelOnLeft = rect.left - visibleLeft > visibleRight - rect.left;
            if (
              rect.bottom <= rect.top ||
              rect.bottom < Math.max(0, bounds.top) ||
              rect.top > Math.min(innerHeight, bounds.bottom) ||
              rect.left < visibleLeft ||
              rect.left > visibleRight
            )
              return [];
            return [
              {
                ...peer,
                left: rect.left - origin.left,
                top: rect.top - origin.top,
                height: rect.height,
                labelOnLeft,
                labelWidth: Math.min(
                  220,
                  labelOnLeft ? rect.left - visibleLeft : visibleRight - rect.left,
                ),
              },
            ];
          } catch {
            return [];
          }
        });
        setRemoteCarets((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        // An agent's select beat collapses to a caret on its own schedule.
        clearTimeout(beatTimer);
        const beat = collab.nextRepaint();
        if (beat !== null) beatTimer = setTimeout(repaint, Math.max(16, beat + 16));
      });
    };
    const repaint = () => {
      if (alive && !editor.composing) editor.dispatch({ annotations: remoteAnnotations() });
      measureCarets();
    };
    const stop = bound.observe((event) => {
      if (writing || !alive) return;
      try {
        collab.observeChange(event);
        let selection;
        const { anchor, head } = editor.state.selection;
        // Let Wordgard map a selected image through the projection change set.
        // Rebuilding it as a text range would bring back text controls on peer edits.
        if (
          !selectedImage(editor.state) &&
          event.nativeBefore &&
          event.nativeAfter &&
          !event.changes.empty
        ) {
          const path = ["blocks", id, "richText"];
          try {
            const caret = anchor === head;
            const a = remoteEditorPosition(event, path, anchor, { caret }),
              h = caret ? a : remoteEditorPosition(event, path, head);
            selection = (cx) =>
              GardSelection.range(GardSelection.near(cx, a).anchor, GardSelection.near(cx, h).head);
          } catch {
            /* Wordgard maps the selection through its change set. */
          }
        }
        editor.dispatch({
          changes: projectChanges(editor.state.doc, event.after.doc),
          selection,
          // The native cursor can move even when the rendered text is equal
          // (a peer deletes one "a" and adds another), so re-resolve always.
          effects: editor.state.field(uploadPreview) ? resolveUploadPreview.of(null) : [],
          annotations: [...remoteAnnotations(), history.isolate.of(true)],
        });
      } catch (error) {
        report(error);
      }
    });
    const stopPresence = replica.watchPresence(repaint);
    refresh.current = () => {
      if (!alive) return;
      const state = editor.state,
        selection = state.selection;
      const saved = pendingLink.current;
      if (saved) {
        try {
          const native = replica.doc,
            path = ["blocks", id, "richText"];
          if (A.getObjectId(native.blocks[id], "richText") !== saved.object)
            throw Error("Link object changed");
          const from = A.getCursorPosition(native, path, saved.first),
            last = A.getCursorPosition(native, path, saved.last);
          if (
            last < from ||
            A.getCursor(native, path, from, "after") !== saved.first ||
            A.getCursor(native, path, last, "before") !== saved.last
          )
            throw Error("Link passage removed");
          if (saved.existing) {
            const currentMark = A.marks(native, path).find(
              (mark) =>
                mark.name === "link" && mark.start <= from && mark.end >= last + saved.width,
            );
            if (
              !currentMark ||
              JSON.stringify(JSON.parse(currentMark.value)) !== JSON.stringify(saved.attrs)
            )
              throw Error("Link changed");
          }
          const map = bound.current.map,
            start = map.amToWg[from],
            end = map.amToWg[last + saved.width];
          if (start === undefined || end === undefined || start > state.doc.length)
            throw Error("Link no longer visible");
          setLink((previous) =>
            previous && (previous.from !== start || previous.to !== end)
              ? { ...previous, from: start, to: end }
              : previous,
          );
        } catch {
          pendingLink.current = null;
          setLink(null);
        }
      }
      const selected = wordgardCommentSelection(replica, id, editor, bound.current.map);
      if (editor.hasFocus) {
        latest.current.onActivate?.();
        latest.current.onSelection?.(selected);
        const presenceKey = `${selection.anchor}:${selection.head}:${A.getHeads(replica.doc).join()}`;
        if (presenceKey !== lastPresence || monotonicNow() - lastPresenceAt > 10000) {
          lastPresence = presenceKey;
          lastPresenceAt = monotonicNow();
          publishWordgardSelection(replica, id, editor, bound.current.map);
        }
      }
      const block = state.sel.head.textblockParent?.node;
      const snapshot = {
        image: !!selectedImage(state),
        table: !!selectedTable(state),
        style:
          block?.type === Heading
            ? `h${block.tag.param}`
            : block?.type === CodeBlock.type
              ? "code"
              : "p",
        undo: undoDepth(state) > 0,
        redo: redoDepth(state) > 0,
        comment: !!selected,
        link: !!selected || !!PagesLink.isInSet(state.sel.activeMarks),
        bullet: listIsActive(BulletList)(state),
        ordered: listIsActive(OrderedList.of(1))(state),
        task: listIsActive(TaskList)(state),
      };
      const highlight = selectionHighlight(state);
      snapshot.highlight = highlight.color;
      snapshot.highlightPresent = highlight.colors.length > 0;
      snapshot.uploadPreview = previewShown(editor);
      snapshot.focused = editor.hasFocus;
      for (const [name, mark] of Object.entries(marks))
        snapshot[name] = selection.empty
          ? !!mark.isInSet(state.sel.activeMarks)
          : !selection.ranges.some((range) =>
              canAddMarkInRange(state.doc, range.from, range.to, mark),
            );
      setFormat((previous) =>
        JSON.stringify(previous) === JSON.stringify(snapshot) ? previous : snapshot,
      );
      positionToolbar.current();
      measureCarets();
    };
    const timer = setInterval(repaint, 1000);
    // Keep remote carets out of Wordgard's document DOM: point widgets can be
    // duplicated while code-block illumination changes. React owns this layer.
    document.addEventListener("scroll", measureCarets, true);
    window.addEventListener("resize", measureCarets);
    const resize = new ResizeObserver(measureCarets);
    resize.observe(editor.contentDOM);
    const article = mount.current.closest("article");
    if (article) resize.observe(article);
    const focusout = () => {
      queueMicrotask(() => {
        if (alive && !editor.hasFocus && replica.presenceValue?.block_id === id)
          replica.publishPresence(null);
      });
    };
    let pointerStart = null;
    const pointerdown = (event) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    };
    const click = (event) => {
      const anchor = event.target.closest?.("a");
      if (anchor && !anchor.closest(".wordgard-widget")) {
        const href = linkDestination(anchor.getAttribute("href"), location.href);
        if (!editor.editable || event.metaKey || event.ctrlKey) {
          if (!href) event.preventDefault();
          return;
        }
        event.preventDefault();
        const position =
          event.detail === 0
            ? editor.posAtDOM(anchor, 0)
            : editor.posAtCoords({ x: event.clientX, y: event.clientY }).pos;
        if (Number.isSafeInteger(position)) openLink(position);
        return;
      }
      if (
        event.target.closest?.(".wordgard-widget,button,select") ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !editor.state.selection.empty ||
        (pointerStart &&
          Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4)
      )
        return;
      const thread = collab.commentAtPosition(
        editor.posAtCoords({ x: event.clientX, y: event.clientY }).pos,
      );
      if (thread) latest.current.onRevealComment?.(thread, "passage");
    };
    // Wordgard maps composition input through incoming transactions. Holding
    // notifications while the canonical document advances would stale that view.
    editor.contentDOM.addEventListener("focusout", focusout);
    editor.contentDOM.addEventListener("pointerdown", pointerdown);
    editor.contentDOM.addEventListener("click", click);
    refresh.current();
    reset((n) => n + 1);
    return () => {
      alive = false;
      uploader.destroy();
      imageUploader.current = null;
      imageTarget.current = null;
      clearInterval(timer);
      if (caretFrame !== null) cancelAnimationFrame(caretFrame);
      clearTimeout(beatTimer);
      document.removeEventListener("scroll", measureCarets, true);
      window.removeEventListener("resize", measureCarets);
      resize.disconnect();
      stop();
      stopPresence();
      collab.destroy();
      bound.destroy();
      if (replica.presenceValue?.block_id === id) replica.publishPresence(null);
      editor.contentDOM.removeEventListener("focusout", focusout);
      editor.contentDOM.removeEventListener("pointerdown", pointerdown);
      editor.contentDOM.removeEventListener("click", click);
      // Removing Wordgard's custom element disconnects its observer, plugins,
      // input handlers, and widgets. It has no separate destroy() method.
      editor.dom.remove();
      view.current = null;
      binding.current = null;
      collaboration.current = null;
      refresh.current = () => {};
    };
  }, [replica, id]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!editable) imageUploader.current?.cancel();
    editor.dispatch({
      effects: permissions.current.reconfigure(editConfig(editable)),
      annotations: remoteAnnotations(),
    });
  }, [editable, generation]);
  useEffect(() => {
    if (view.current && !view.current.composing)
      view.current.dispatch({ annotations: remoteAnnotations() });
  }, [threads, commentTarget, commentDraft, generation]);
  useEffect(() => {
    if (commentTarget?.source !== "quote") return;
    const thread = threads?.find((thread) => thread.id === commentTarget.id);
    if (thread) collaboration.current?.revealThread(thread);
  }, [commentTarget, threads, generation]);
  useEffect(() => {
    const media = matchMedia(MOBILE_EDITOR_QUERY);
    const change = () => setMobile(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const editor = view.current,
      element = toolbar.current;
    if (!editor || !element || !toolbarHost || !editable) {
      setFloating(null);
      setContextualToolbar(false);
      return;
    }
    let frame = null,
      dragging = false;
    const position = () => {
      frame = null;
      // Freeze the overlay while the pointer is choosing a new range. Moving it
      // into a dock here shifts the text underneath the selection gesture.
      if (dragging) return;
      let next = null;
      const selection = editor.state.selection;
      const contextual =
        !mobile &&
        !selection.empty &&
        !selectedImage(editor.state) &&
        !editor.composing &&
        (editor.hasFocus ||
          element.contains(document.activeElement) ||
          !!element.querySelector('[aria-expanded="true"]'));
      setContextualToolbar(contextual);
      if (contextual && !toolbarOpen) {
        const viewport = window.visualViewport,
          box = element.getBoundingClientRect();
        next = selectionToolbarPosition({
          start: editor.coordsAtPos(selection.from),
          end: editor.coordsAtPos(selection.to),
          width: box.width,
          height: box.height,
          viewport: {
            left: viewport?.offsetLeft ?? 0,
            top: Math.max(
              document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0,
              viewport?.offsetTop ?? 0,
            ),
            right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
            bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
          },
        });
      }
      setFloating((previous) =>
        previous?.left === next?.left && previous?.top === next?.top ? previous : next,
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(position);
    };
    const down = (event) => {
      if (editor.dom.contains(event.target) && event.button === 0) {
        dragging = true;
        schedule();
      }
    };
    const up = () => {
      dragging = false;
      schedule();
    };
    positionToolbar.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const listeners = [
      [window, "resize", schedule],
      [window, "scroll", schedule],
      [document, "focusin", schedule],
      [document, "pointerdown", down],
      [document, "pointerup", up],
      [document, "pointercancel", up],
      [window.visualViewport, "resize", schedule],
      [window.visualViewport, "scroll", schedule],
    ];
    listeners.forEach(([target, name, fn]) => target?.addEventListener(name, fn, true));
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      listeners.forEach(([target, name, fn]) => target?.removeEventListener(name, fn, true));
      positionToolbar.current = () => {};
    };
  }, [toolbarHost, toolbarOpen, editable, generation, mobile]);
  function run(name) {
    const editor = view.current;
    if (!editor || !editable) return;
    try {
      if (name === "comment") return comment();
      if (name === "link") return openLink();
      if (name === "highlight") Command.dispatch(editor, toggleHighlight);
      else if (name === "table") insertTable(editor);
      else if (marks[name]) Command.dispatch(editor, toggleMark, marks[name]);
      else if (name === "undo" || name === "redo")
        Command.dispatch(editor, name === "undo" ? undo : redo);
      else if (["bullet", "ordered", "task"].includes(name))
        Command.dispatch(
          editor,
          toggleList,
          name === "task" ? TaskList : name === "bullet" ? BulletList : OrderedList.of(1),
        );
      else
        Command.dispatch(
          editor,
          setTextblockType,
          name === "code-block"
            ? CodeBlock
            : name.startsWith("h")
              ? Heading.of(Number(name.slice(1)))
              : Paragraph,
        );
      editor.focus();
    } catch (error) {
      report(error);
    }
  }
  // Mobile bar commands act only while this editor or its bar holds focus.
  function ownsBar() {
    const editor = view.current;
    return !!editor && (editor.hasFocus || !!mobileBar.current?.contains(document.activeElement));
  }
  function chooseImage() {
    const editor = view.current;
    if (!editor || !editable || imageStatus?.pending) return;
    try {
      imageTarget.current = captureImageInsertion(replica, id, editor, binding.current.current.map);
      imageInput.current?.click();
    } catch (error) {
      setImageStatus({ pending: false, message: error.message, retryable: false });
    }
  }
  function toolbarKeys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      view.current?.focus();
      return;
    }
    if (
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
      event.target.tagName === "SELECT"
    )
      return;
    const controls = [
        ...event.currentTarget.querySelectorAll("button:not(:disabled),select:not(:disabled)"),
      ],
      index = controls.indexOf(event.target);
    if (!controls.length) return;
    event.preventDefault();
    controls[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length
    ].focus();
  }
  function formatButton([name, label, Icon]) {
    const action = actions.has(name);
    return (
      <button
        key={name}
        className={`toolbar-button${format?.[name] && !action ? " is-active" : ""}`}
        aria-label={label}
        title={label}
        aria-pressed={action ? undefined : !!format?.[name]}
        disabled={!editable || (action && !format?.[name])}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => run(name)}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="rich-editor wordgard-editor">
      {toolbarHost &&
        createPortal(
          <div
            ref={toolbar}
            className={`rich-toolbar ${toolbarOpen ? "is-pinned" : "is-contextual"}${floating ? " is-floating" : ""}`}
            hidden={!editable || (!toolbarOpen && !contextualToolbar)}
            style={floating || undefined}
            role="toolbar"
            aria-label={format?.image ? "Image actions" : "Text formatting"}
            onKeyDown={toolbarKeys}
          >
            {toolbarOpen &&
              historyControls.map(([name, label, Icon]) => (
                <button
                  key={name}
                  className="toolbar-button"
                  aria-label={label}
                  title={label}
                  disabled={!editable || !format?.[name]}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => run(name)}
                >
                  <Icon size={18} aria-hidden="true" />
                </button>
              ))}
            {toolbarOpen && <span className="toolbar-separator" role="separator" />}
            {format?.image ? (
              <span className="image-selection-label">Image</span>
            ) : (
              <>
                <select
                  className="toolbar-select"
                  aria-label="Text style"
                  disabled={!editable || format?.table}
                  value={format?.style ?? "p"}
                  onChange={(event) =>
                    run(event.target.value === "code" ? "code-block" : event.target.value)
                  }
                >
                  {styles.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <span className="toolbar-separator" role="separator" />
                {markControls.map((control) => (
                  <Fragment key={control[0]}>
                    {formatButton(control)}
                    {control[0] === "code" && (
                      <HighlightMenu
                        editor={view.current}
                        current={format?.highlight ?? null}
                        present={!!format?.highlightPresent}
                        editable={editable}
                        onError={report}
                      />
                    )}
                  </Fragment>
                ))}
                {toolbarOpen && listControls.map(formatButton)}
                {(toolbarOpen || format?.table) && (
                  <>
                    <span className="toolbar-separator" role="separator" />
                    <TableMenu
                      editor={view.current}
                      inTable={!!format?.table}
                      editable={editable}
                      onError={report}
                    />
                  </>
                )}
                {toolbarOpen && (
                  <button
                    className="toolbar-button"
                    aria-label="Insert image"
                    title="Insert image"
                    disabled={!editable || imageStatus?.pending}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={chooseImage}
                  >
                    <ImagePlus size={18} aria-hidden="true" />
                  </button>
                )}
                {formatButton(commentControl)}
              </>
            )}
          </div>,
          toolbarHost,
        )}
      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        aria-label="Choose image"
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []),
            target = imageTarget.current;
          event.target.value = "";
          imageTarget.current = null;
          if (files.length && target) imageUploader.current?.start(files, target);
        }}
      />
      {imageStatus && !(imageStatus.pending && format?.uploadPreview) && (
        <div className="image-upload-status" role="status" aria-live="polite">
          <span>{imageStatus.message}</span>
          {imageStatus.retryable && editable && (
            <button type="button" onClick={() => imageUploader.current?.retry()}>
              Retry
            </button>
          )}
          <button type="button" onClick={() => imageUploader.current?.cancel()}>
            {imageStatus.pending ? "Cancel" : "Dismiss"}
          </button>
        </div>
      )}
      {mobile && editable && (format?.focused || barFocus) && (
        <MobileBar
          barRef={mobileBar}
          format={format}
          editable={editable}
          styles={styles}
          openComments={props.openComments ?? 0}
          editorDom={view.current?.dom}
          onRun={(name) => ownsBar() && run(name)}
          onStyle={(value) => ownsBar() && run(value === "code" ? "code-block" : value)}
          onImage={() => ownsBar() && chooseImage()}
          onComments={() => props.onOpenComments?.()}
          onFocusChange={setBarFocus}
        />
      )}
      <div ref={mount} />
      <div ref={caretLayer} className="wordgard-caret-layer" aria-hidden="true">
        {remoteCarets.map((peer) => {
          const color = peer.color && {
            "--peer-color": peer.color.background,
            "--peer-foreground": peer.color.foreground,
          };
          if (peer.type === "bar")
            return (
              <span
                key={peer.session}
                className="agent-reading"
                title={peer.title}
                style={{ ...color, left: peer.left, top: peer.top, height: peer.height }}
              >
                {peer.label && <span>{peer.label}</span>}
              </span>
            );
          if (peer.type === "dot")
            return (
              <span
                key={peer.session}
                className={`agent-dot${peer.idle ? " is-idle" : ""}`}
                title={peer.title}
                style={{ ...color, left: peer.left, top: peer.top }}
              >
                {!peer.idle && (
                  <span>
                    {peer.displayName}
                    {peer.tag && <em>{peer.tag}</em>}
                    {peer.message && <small>{peer.message}</small>}
                  </span>
                )}
              </span>
            );
          return (
            <span
              key={peer.session}
              className={`peer-caret${peer.idle ? " is-idle" : ""}`}
              data-label-side={peer.labelOnLeft ? "left" : "right"}
              title={peer.title}
              style={{ ...color, left: peer.left, top: peer.top, height: peer.height }}
            >
              {!peer.idle && (
                <span style={{ maxWidth: peer.labelWidth }}>
                  {peer.displayName}
                  {peer.tag && <em>{peer.tag}</em>}
                  {peer.message && <small>{peer.message}</small>}
                </span>
              )}
            </span>
          );
        })}
      </div>
      {link && view.current && (
        <LinkPopover
          view={{
            coordsAtPos: (position) => view.current?.coordsAtPos(position),
            get isDestroyed() {
              return !view.current;
            },
          }}
          target={link}
          editable={editable}
          editing={editingLink}
          onEdit={() => setEditingLink(true)}
          onChange={changeLink}
          onClose={(focus) => {
            setLink(null);
            pendingLink.current = null;
            if (focus) view.current?.focus();
          }}
        />
      )}
    </div>
  );
}
