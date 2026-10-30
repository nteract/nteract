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
import { tablePresentation, tableKeys, selectedTable } from "./wordgard-tables.mjs";
import { TableMenu } from "./TableMenu.jsx";
import { HighlightMenu } from "./HighlightMenu.jsx";
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
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { PagesLink, TaskList, elements } from "./wordgard-model.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
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
import {
  IMAGE_ACCEPT,
  captureImageInsertion,
  createImageUploader,
  imageFiles,
} from "./image-upload.mjs";
import "./wordgard.css";

const styles = [
  ["p", "Paragraph"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["code", "Code block"],
];
const controls = [
  ["undo", "Undo", Undo2],
  ["redo", "Redo", Redo2],
  ["bold", "Bold", Bold],
  ["italic", "Italic", Italic],
  ["code", "Inline code", CodeIcon],
  ["bullet", "Bulleted list", List],
  ["ordered", "Numbered list", ListOrdered],
  ["task", "Task list", ListTodo],
  ["link", "Link", LinkIcon],
  ["comment", "Comment on selection", MessageSquare],
];
const marks = { bold: Strong, italic: Emphasis, code: Code };
const remoteAnnotations = () => [Transaction.remote.of(true), Transaction.addToHistory.of(false)];
const languages = [
  "Mermaid",
  "Bash",
  "CSS",
  "HTML",
  "JavaScript",
  "JSON",
  "Markdown",
  "Python",
  "R",
  "Rust",
  "SQL",
  "TypeScript",
  "YAML",
];
const editConfig = (editable) => [
  GardState.readOnly.of(!editable),
  Wordgard.editable.of(editable),
  codeBlockLanguage(),
  ...(editable ? wordgardCodeLanguages(languages) : []),
];

export function WordgardEditor(props) {
  const { replica, id, editable, toolbarHost, toolbarOpen = false, threads, commentTarget } = props;
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
    [imageStatus, setImageStatus] = useState(null);
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
        undoHistory.extension,
        permissions.current.of(editConfig(latest.current.editable)),
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
        KeyBinding.of({
          key: "Mod-Shift-h",
          run: () => latest.current.editable && Command.dispatch(editor, toggleHighlight),
        }),
        Wordgard.contentAttributes.of({ "aria-label": "Document text", spellcheck: "true" }),
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
      onState: setImageStatus,
    });
    imageUploader.current = uploader;
    editor.dom.classList.add("wordgard-document");
    let caretFrame = null;
    const measureCarets = () => {
      if (!alive || caretFrame !== null) return;
      caretFrame = requestAnimationFrame(() => {
        caretFrame = null;
        if (!alive || !caretLayer.current) return;
        const origin = caretLayer.current.getBoundingClientRect();
        const bounds = editor.contentDOM.getBoundingClientRect();
        const next = collab.carets().flatMap((peer) => {
          try {
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
            const translate = (pos) => {
              const cursor = A.getCursor(
                event.nativeBefore,
                path,
                event.before.map.wgToAm[pos],
                "after",
              );
              const offset = A.getCursorPosition(event.nativeAfter, path, cursor);
              return event.after.map.amToWg[offset] ?? event.after.doc.length - 1;
            };
            const a = translate(anchor),
              h = translate(head);
            selection = (cx) =>
              GardSelection.range(GardSelection.near(cx, a).anchor, GardSelection.near(cx, h).head);
          } catch {
            /* Wordgard maps the selection through its change set. */
          }
        }
        editor.dispatch({
          changes: projectChanges(editor.state.doc, event.after.doc),
          selection,
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
        if (presenceKey !== lastPresence || Date.now() - lastPresenceAt > 10000) {
          lastPresence = presenceKey;
          lastPresenceAt = Date.now();
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
  }, [threads, commentTarget, generation]);
  useEffect(() => {
    if (commentTarget?.source !== "quote") return;
    const thread = threads?.find((thread) => thread.id === commentTarget.id);
    if (thread) collaboration.current?.revealThread(thread);
  }, [commentTarget, threads, generation]);
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
  }, [toolbarHost, toolbarOpen, editable, generation]);
  function run(name) {
    const editor = view.current;
    if (!editor || !editable) return;
    try {
      if (name === "comment") return comment();
      if (name === "link") return openLink();
      if (marks[name]) Command.dispatch(editor, toggleMark, marks[name]);
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
              controls.slice(0, 2).map(([name, label, Icon]) => (
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
                {(toolbarOpen || format?.table) && (
                  <TableMenu
                    editor={view.current}
                    inTable={!!format?.table}
                    editable={editable}
                    onError={report}
                  />
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
                {controls
                  .slice(2)
                  .filter(([name]) => toolbarOpen || !["bullet", "ordered", "task"].includes(name))
                  .map(([name, label, Icon]) => (
                    <Fragment key={name}>
                      <button
                        className={`toolbar-button${format?.[name] && !["link", "comment"].includes(name) ? " is-active" : ""}`}
                        aria-label={label}
                        title={label}
                        aria-pressed={
                          !["link", "comment"].includes(name) ? !!format?.[name] : undefined
                        }
                        disabled={
                          !editable || (["link", "comment"].includes(name) && !format?.[name])
                        }
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => run(name)}
                      >
                        <Icon size={18} aria-hidden="true" />
                      </button>
                      {name === "code" && (
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
      {imageStatus && (
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
      <div ref={mount} />
      <div ref={caretLayer} className="wordgard-caret-layer" aria-hidden="true">
        {remoteCarets.map((peer) => (
          <span
            key={peer.session}
            className="peer-caret"
            data-label-side={peer.labelOnLeft ? "left" : "right"}
            style={{ left: peer.left, top: peer.top, height: peer.height }}
          >
            <span style={{ maxWidth: peer.labelWidth }}>{peer.displayName}</span>
          </span>
        ))}
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
