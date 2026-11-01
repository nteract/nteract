import { useEffect, useRef, useState } from "react";
import * as A from "@automerge/automerge/slim";
import { Wordgard, Decoration, KeyBinding } from "wordgard/editor";
import { GardState, Transaction } from "wordgard/state";
import { Command, toggleMark, toggleList, listIsActive, canAddMarkInRange } from "wordgard/command";
import { history } from "wordgard/history";
import { tables } from "wordgard/table";
import {
  blockDoc,
  paragraph,
  heading,
  lineBreak,
  strong,
  emphasis,
  code,
  codeBlock,
  bulletList,
  orderedList,
  blockquote,
} from "wordgard/schema";
import { Bold, Italic, Code as CodeIcon, List, ListTodo, Link as LinkIcon } from "lucide-react";
import {
  decode,
  encode,
  elements,
  Strong,
  Emphasis,
  Code,
  BulletList,
  TaskList,
  PagesLink,
  PagesImage,
} from "./wordgard-model.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
import { markdownShortcuts } from "./wordgard-shortcuts.mjs";
import { tablePresentation, tableKeys } from "./wordgard-tables.mjs";
import { setUploadPreview, uploadPreview, uploadPreviews } from "./upload-preview.mjs";
import { createCommentImageUploader, imageFiles } from "./comment-image.mjs";
import { codeHighlighting } from "./code-highlight.mjs";
import {
  insertPlainLineBreak,
  wordgardCodeNewlines,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import { linkDestination } from "./link-destination.mjs";
import {
  markdownCommentSpans,
  commentSpansMarkdown,
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_BYTES,
} from "../model/comment-content.mjs";
import { isRich } from "../model/richtext.mjs";
import "./wordgard.css";

const permissions = (editable) => [
  GardState.readOnly.of(!editable),
  Wordgard.editable.of(editable),
];
const quiet = () => [Transaction.remote.of(true), Transaction.addToHistory.of(false)];
const controls = [
  ["Bold", Bold, toggleMark, Strong],
  ["Italic", Italic, toggleMark, Emphasis],
  ["Inline code", CodeIcon, toggleMark, Code],
  ["Bulleted list", List, toggleList, BulletList],
  ["Task list", ListTodo, toggleList, TaskList],
];

// Comments use the document's native vocabulary, so tables and images an agent
// writes render here too. Drafts stay local until Send; posted messages are
// never edited by a viewer selection.
function nativeConfig() {
  return [
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
    wordgardCodeNewlines,
    wordgardListStarts,
    codeHighlighting,
    KeyBinding.of({ key: "Shift-Enter", run: insertPlainLineBreak }),
    Decoration.Mark.shape(PagesLink, {
      element: "a",
      attributes: (value) => {
        const href = linkDestination(value.href, location.href);
        return href
          ? { href, title: value.title ?? "", target: "_blank", rel: "noopener noreferrer" }
          : {};
      },
    }),
  ];
}

/**
 * `images` turns on image paste and drop: `{ pageId, canUpload }`. Uploads use
 * the Page's asset endpoint, and the draft gets the asset URL the way Page
 * Markdown does. `onUploadingChange(boolean)` lets the form hold Send while
 * an image uploads.
 */
export function CommentRichText({
  value,
  nativeSpans,
  onChange,
  onError,
  disabled,
  label,
  images,
  onUploadingChange,
}) {
  const mount = useRef(null),
    view = useRef(null),
    compartment = useRef(new GardState.Compartment());
  const latest = useRef({ value, nativeSpans, onChange, onError, disabled, images });
  latest.current = { value, nativeSpans, onChange, onError, disabled, images, onUploadingChange };
  const lastValue = useRef(value);
  const uploader = useRef(null);
  const [editor, setEditor] = useState(null),
    [format, setFormat] = useState({}),
    [imageProblem, setImageProblem] = useState("");
  const [link, setLink] = useState(null),
    [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const linkInput = useRef(null);
  useEffect(() => {
    if (link) linkInput.current?.focus();
  }, [link]);
  useEffect(() => {
    let alive = true;
    function refreshFormatting(state) {
      if (!alive) return;
      const selection = state.selection;
      const next = Object.fromEntries(
        controls.map(([name, , command, arg]) => [
          name,
          command === toggleList
            ? listIsActive(arg)(state)
            : selection.empty
              ? !!arg.isInSet(state.sel.activeMarks)
              : !selection.ranges.some((range) =>
                  canAddMarkInRange(state.doc, range.from, range.to, arg),
                ),
        ]),
      );
      setFormat((previous) =>
        controls.every(([name]) => previous[name] === next[name]) ? previous : next,
      );
    }
    // Where a pasted or dropped image will land, until its upload starts.
    let landing = null;
    const images = createCommentImageUploader({
      pageId: latest.current.images?.pageId,
      insert(asset, alt) {
        const pending = editor.state.field(uploadPreview, false);
        if (!alive || !pending || editor.state.readOnly)
          throw Error("The draft changed while the image uploaded. Add it again.");
        editor.dispatch({
          changes: {
            from: pending.pos,
            insert: [PagesImage.of({ src: asset.url, alt, title: null })],
            fit: true,
          },
          effects: setUploadPreview.of(null),
          userEvent: "input.image",
          annotations: history.isolate.of(true),
        });
      },
      onState(state) {
        if (!alive) return;
        setImageProblem(state.name === "failed" ? state.message : "");
        latest.current.onUploadingChange?.(state.name === "uploading");
        if (state.name === "uploading" && landing) {
          const { pos, file } = landing;
          landing = null;
          const preview = {
            resolve: () => pos,
            src: "",
            name: file.name ?? "",
            onCancel: () => images.cancel(),
          };
          editor.dispatch({ effects: setUploadPreview.of(preview), annotations: quiet() });
          // A data: URL of the file shows while it uploads (the page CSP
          // allows data: images, not blob:).
          if (typeof FileReader === "function") {
            const reader = new FileReader();
            reader.onload = () => {
              const current = editor.state.field(uploadPreview, false);
              if (
                !alive ||
                images.state.name !== "uploading" ||
                current?.resolve !== preview.resolve
              )
                return;
              editor.dispatch({
                effects: setUploadPreview.of({
                  ...preview,
                  resolve: () => current.pos,
                  src: reader.result,
                }),
                annotations: quiet(),
              });
            };
            reader.readAsDataURL(file);
          }
        } else if (state.name !== "uploading" && editor.state.field(uploadPreview, false))
          editor.dispatch({ effects: setUploadPreview.of(null), annotations: quiet() });
      },
    });
    uploader.current = images;
    const acceptImages = (files, pos) => {
      if (!files.length || !latest.current.images) return false;
      if (latest.current.disabled) return true;
      landing = { pos: pos ?? editor.state.selection.to, file: files[0] };
      const handled = images.accept(files, { canUpload: latest.current.images.canUpload });
      landing = null;
      return handled;
    };
    const editor = Wordgard.create({
      parent: mount.current,
      doc: decode(latest.current.nativeSpans ?? markdownCommentSpans(latest.current.value)).doc,
      config: [
        ...nativeConfig(),
        uploadPreviews,
        Wordgard.domEventHandler("paste", (event) => acceptImages(imageFiles(event.clipboardData))),
        Wordgard.domEventHandler("drop", (event) => {
          const files = imageFiles(event.dataTransfer);
          if (!files.length) return false;
          return acceptImages(
            files,
            editor.posAtCoords({ x: event.clientX, y: event.clientY })?.pos,
          );
        }),
        history(),
        compartment.current.of(permissions(!latest.current.disabled)),
        Wordgard.contentAttributes.of({
          "aria-label": label,
          role: "textbox",
          "aria-multiline": "true",
          spellcheck: "true",
        }),
        Wordgard.exceptionSink.of((error) => latest.current.onError(error.message)),
        Wordgard.transactionListener.of((transactions) => {
          if (!alive) return;
          for (const tr of transactions) {
            if (!tr.docChanged || tr.annotation(Transaction.remote)) continue;
            // Offsets belong to the draft revision at which the link UI opened.
            // Re-select rather than applying a stale range after another edit.
            setLink(null);
            setLinkError("");
            if (images.state.name === "failed") images.cancel();
            try {
              const spans = encode(tr.state.doc),
                markdown = commentSpansMarkdown(spans);
              lastValue.current = markdown;
              latest.current.onChange(markdown, spans);
              latest.current.onError(
                markdown.length > COMMENT_MAX_LENGTH ||
                  new TextEncoder().encode(JSON.stringify(spans)).length > COMMENT_MAX_BYTES
                  ? "This comment is too large. Shorten it before sending."
                  : "",
              );
            } catch (error) {
              latest.current.onError(error.message);
            }
          }
        }),
        Wordgard.updateListener.of(() => {
          refreshFormatting(editor.state);
        }),
      ],
    });
    view.current = editor;
    editor.dom.classList.add("wordgard-document");
    setEditor(editor);
    refreshFormatting(editor.state);
    return () => {
      images.destroy();
      latest.current.onUploadingChange?.(false);
      alive = false;
      uploader.current = null;
      editor.dom.remove();
      view.current = null;
    };
  }, [label]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartment.current.reconfigure(permissions(!disabled)),
      annotations: quiet(),
    });
  }, [disabled]);
  useEffect(() => {
    if (!view.current || value === lastValue.current) return;
    lastValue.current = value;
    // The draft was replaced: an upload's insertion point is gone with it.
    if (uploader.current?.state.name === "uploading") uploader.current.cancel();
    view.current.dispatch({
      changes: projectChanges(
        view.current.state.doc,
        decode(nativeSpans ?? markdownCommentSpans(value)).doc,
      ),
      effects: view.current.state.field(uploadPreview, false) ? setUploadPreview.of(null) : [],
      annotations: quiet(),
    });
  }, [value, nativeSpans]);
  function run(command, arg) {
    if (!editor?.editable) return;
    try {
      Command.dispatch(editor, command, arg);
      editor.focus();
    } catch (error) {
      onError(error.message);
    }
  }
  function toolbarKeys(event) {
    // Keys from a portaled child still bubble through its React parent; only
    // the toolbar's own buttons navigate here.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      editor?.focus();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(event.target);
    if (!buttons.length || index < 0) return;
    event.preventDefault();
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length
    ].focus();
  }
  return (
    <div className="comment-rich-editor wordgard-editor">
      <div
        className="comment-formatting"
        role="toolbar"
        aria-label={`${label} formatting`}
        onKeyDown={toolbarKeys}
      >
        {controls.map(([name, Icon, command, arg]) => (
          <button
            key={name}
            type="button"
            className={`toolbar-button${format[name] ? " is-active" : ""}`}
            title={name}
            aria-label={name}
            aria-pressed={Boolean(format[name])}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => run(command, arg)}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          className="toolbar-button"
          aria-label="Link"
          title="Link"
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const range = editor?.state.selection;
            if (!range || range.empty) {
              setLinkError("Select text to add a link.");
              return;
            }
            setLinkError("");
            setLink({ from: range.from, to: range.to });
            setHref("");
          }}
        >
          <LinkIcon size={16} aria-hidden="true" />
        </button>
      </div>
      {link && (
        <div
          className="comment-link-editor"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setLink(null);
              setLinkError("");
              editor?.focus();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.querySelector("button")?.click();
            }
          }}
        >
          <input
            ref={linkInput}
            aria-label="Comment link URL"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            placeholder="https://…"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!editor?.editable || !linkDestination(href, location.href)) {
                setLinkError("Enter a valid web, email, or telephone link.");
                return;
              }
              editor.dispatch({
                changes: { ...link, add: PagesLink.of({ href, title: null }) },
                userEvent: "input.link",
                annotations: history.isolate.of(true),
              });
              setLink(null);
              setLinkError("");
              editor.focus();
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setLink(null);
              setLinkError("");
              editor?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {linkError && (
        <p className="error" role="status">
          {linkError}
        </p>
      )}
      {imageProblem && (
        <p className="error" role="status">
          {imageProblem}
        </p>
      )}
      <div ref={mount} className="comment-rich-scroll" />
    </div>
  );
}

export function CommentContent({ message, source }) {
  const mount = useRef(null);
  const rich = isRich(source);
  const unavailable = message.content_error === "rich_text_unavailable";
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    setProblem(false);
    if (!rich || unavailable) return;
    let editor;
    try {
      editor = Wordgard.create({
        parent: mount.current,
        doc: decode(A.spans(source, ["richText"])).doc,
        config: [
          ...nativeConfig(),
          ...permissions(false),
          Wordgard.exceptionSink.of(() => setProblem(true)),
        ],
      });
      editor.dom.classList.add("wordgard-document");
    } catch {
      setProblem(true);
    }
    return () => editor?.dom.remove();
  }, [source, rich, unavailable]);
  if (!rich && !unavailable) return <p>{message.body}</p>;
  return (
    <div className="comment-rich-content wordgard-editor">
      <div ref={mount} hidden={problem || unavailable} />
      {(problem || unavailable) && (
        <>
          <p className="muted">
            {unavailable
              ? "Rich text is unavailable. The original comment text is shown below and may not include later edits."
              : "This comment could not be formatted. Its current Markdown is shown below."}
          </p>
          <pre>{message.body}</pre>
        </>
      )}
    </div>
  );
}
