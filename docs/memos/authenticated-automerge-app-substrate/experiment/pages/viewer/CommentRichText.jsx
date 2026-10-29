import { useEffect, useRef, useState } from "react";
import * as A from "@automerge/automerge/slim";
import { Wordgard, Decoration } from "wordgard/editor";
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
} from "./wordgard-model.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
import { tablePresentation, tableKeys, selectedTable } from "./wordgard-tables.mjs";
import { TableMenu } from "./TableMenu.jsx";
import { wordgardCodeNewlines, wordgardListStarts } from "./wordgard-binding.mjs";
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

// Comments use the document's native vocabulary and table commands. Drafts stay
// local until Send; posted messages are never edited by a viewer selection.
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
    tables({ cellContent: "inline", cellSpanning: false }),
    tablePresentation,
    tableKeys,
    GardState.schemaElement.of(elements),
    wordgardCodeNewlines,
    wordgardListStarts,
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

export function CommentRichText({ value, nativeSpans, onChange, onError, disabled, label }) {
  const mount = useRef(null),
    view = useRef(null),
    compartment = useRef(new GardState.Compartment());
  const latest = useRef({ value, nativeSpans, onChange, onError, disabled });
  latest.current = { value, nativeSpans, onChange, onError, disabled };
  const lastValue = useRef(value);
  const [editor, setEditor] = useState(null),
    [inTable, setInTable] = useState(false),
    [format, setFormat] = useState({});
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
      setInTable(Boolean(selectedTable(state)));
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
    const editor = Wordgard.create({
      parent: mount.current,
      doc: decode(latest.current.nativeSpans ?? markdownCommentSpans(latest.current.value)).doc,
      config: [
        ...nativeConfig(),
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
      alive = false;
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
    view.current.dispatch({
      changes: projectChanges(
        view.current.state.doc,
        decode(nativeSpans ?? markdownCommentSpans(value)).doc,
      ),
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
    // A table menu is portaled outside the toolbar but still bubbles through
    // its React parent. Let that menu keep its own keyboard navigation.
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
        <TableMenu
          editor={editor}
          inTable={inTable}
          editable={!disabled && !!editor}
          onError={(error) => onError(error.message)}
        />
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
      <div ref={mount} />
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
