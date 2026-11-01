import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Code as CodeIcon,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  MessageSquarePlus,
  MoreHorizontal,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { MOBILE_COMMENT_HINT, MOBILE_COMMENT_LABELS } from "./mobile-comment.mjs";

// Overflow actions, in the order the mockup shows them.
const MORE = [
  ["highlight", "Highlight", Highlighter],
  ["undo", "Undo", Undo2],
  ["redo", "Redo", Redo2],
  ["ordered", "Numbered list", ListOrdered],
  ["task", "Task list", ListTodo],
  ["strike", "Strikethrough", Strikethrough],
  ["code", "Inline code", CodeIcon],
  ["table", "Insert table", Table],
  ["link", "Link", LinkIcon],
];
const HINT_MS = 3000;

/**
 * The compact formatting bar for narrow touch screens. It's fixed to the
 * bottom of the visual viewport (--vv-bottom), so it rides above the iOS
 * keyboard and its accessory row. Buttons keep the editor focused, so the
 * keyboard stays up while formatting.
 *
 * Every button here acts on the editor. Comment opens the composer for the
 * selection or, with none, the caret's paragraph (see mobile-comment.mjs).
 * Showing the open comments is the header's Comments button.
 */
export function MobileBar({
  format,
  editable,
  styles,
  onRun,
  onStyle,
  onImage,
  onComment,
  onFocusChange,
  barRef,
  editorDom,
}) {
  const [more, setMore] = useState(false);
  const [hint, setHint] = useState("");
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(""), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);
  const moreButton = useRef(null),
    menu = useRef(null);
  useEffect(() => {
    if (!more) return;
    const outside = (event) => {
      if (!menu.current?.contains(event.target) && !moreButton.current?.contains(event.target))
        setMore(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [more]);
  useEffect(() => onFocusChange?.(more), [more, onFocusChange]);
  // The bar belongs to one editor. When focus moves anywhere else, by pointer,
  // keyboard or code (into a Reply composer, the title), close the menu and
  // let the bar go, so no command can reach this editor from there.
  useEffect(() => {
    const away = (event) => {
      const target = event.target;
      if (barRef.current?.contains(target) || editorDom?.contains(target)) return;
      setMore(false);
      onFocusChange?.(false);
    };
    document.addEventListener("focusin", away, true);
    return () => document.removeEventListener("focusin", away, true);
  }, [barRef, editorDom, onFocusChange]);
  const keep = (event) => event.preventDefault();
  const enabled = (name) =>
    editable &&
    (name === "undo" || name === "redo" || name === "link"
      ? !!format?.[name]
      : name !== "table" || !format?.table);
  const pick = (name) => {
    setMore(false);
    onRun(name);
  };
  return createPortal(
    <div
      ref={barRef}
      className="mobile-bar"
      role="toolbar"
      aria-label="Text formatting"
      onFocus={() => onFocusChange?.(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (event.currentTarget.contains(next)) return;
        // Back to the editor keeps the bar; the editor's own focus shows it.
        if (!editorDom?.contains(next)) setMore(false);
        onFocusChange?.(false);
      }}
    >
      <select
        className="mobile-bar-style"
        aria-label="Text style"
        disabled={!editable || format?.table || format?.image}
        value={format?.style ?? "p"}
        onChange={(event) => onStyle(event.target.value)}
      >
        {styles.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {[
        ["bold", "Bold", Bold],
        ["italic", "Italic", Italic],
        ["bullet", "Bulleted list", List],
      ].map(([name, label, Icon]) => (
        <button
          key={name}
          type="button"
          className={`mobile-bar-button${format?.[name] ? " is-active" : ""}`}
          aria-label={label}
          aria-pressed={!!format?.[name]}
          disabled={!editable || format?.image}
          onPointerDown={keep}
          onClick={() => onRun(name)}
        >
          <Icon size={20} aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        className="mobile-bar-button"
        aria-label="Insert image"
        disabled={!editable}
        onPointerDown={keep}
        onClick={onImage}
      >
        <ImageIcon size={20} aria-hidden="true" />
      </button>
      <span className="mobile-bar-spacer" />
      <button
        type="button"
        className="mobile-bar-button"
        aria-label={MOBILE_COMMENT_LABELS[format?.commentScope ?? "none"]}
        disabled={!editable}
        onPointerDown={keep}
        onClick={() => {
          setMore(false);
          setHint(onComment() ? "" : MOBILE_COMMENT_HINT);
        }}
      >
        <MessageSquarePlus size={20} aria-hidden="true" />
      </button>
      <button
        ref={moreButton}
        type="button"
        className="mobile-bar-button"
        aria-label="More formatting"
        aria-haspopup="menu"
        aria-expanded={more}
        disabled={!editable}
        onPointerDown={keep}
        onClick={() => setMore(!more)}
      >
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
      {more && (
        <div ref={menu} className="mobile-bar-menu" role="menu" aria-label="More formatting">
          {MORE.map(([name, label, Icon]) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              disabled={!enabled(name)}
              onPointerDown={keep}
              onClick={() => pick(name)}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mobile-bar-hint" role="status">
        {hint}
      </p>
    </div>,
    document.body,
  );
}
