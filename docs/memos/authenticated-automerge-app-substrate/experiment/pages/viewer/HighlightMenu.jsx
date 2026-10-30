import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Highlighter, Eraser } from "lucide-react";
import { Command } from "wordgard/command";
import { HIGHLIGHT_COLORS } from "../model/marks.mjs";
import { clearHighlight, setHighlight } from "./highlight.mjs";

const label = (color) => `${color[0].toUpperCase()}${color.slice(1)} highlight`;

// The palette lives in marks.json. Custom #rrggbb colors are available to the
// API and render here, but the menu offers only the palette.
export function HighlightMenu({ editor, current, present, editable, onError }) {
  const button = useRef(null),
    menu = useRef(null);
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState(null);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, innerWidth - 220)),
          top: Math.max(8, Math.min(rect.bottom + 6, innerHeight - 64)),
        });
    };
    place();
    const outside = (event) => {
      if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const visible = open && position !== null;
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() =>
      (
        menu.current?.querySelector('[aria-checked="true"]') ??
        menu.current?.querySelector("button")
      )?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  function run(command, value) {
    try {
      if (!editor?.editable) return close();
      Command.dispatch(editor, command, value);
      close();
      editor.focus();
    } catch (error) {
      onError(error);
    }
  }
  function keys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const items = [...menu.current.querySelectorAll("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (forward ? 1 : -1) + items.length) % items.length
    ]?.focus();
  }
  const swatch = current && !current.startsWith("#") ? current : null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`toolbar-button highlight-button${current ? " is-active" : ""}`}
        aria-label="Highlight"
        title="Highlight (⌘⇧H)"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!editable}
        data-highlight={swatch ?? (current ? "custom" : undefined)}
        style={current?.startsWith("#") ? { "--pages-highlight-custom": current } : undefined}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Highlighter size={18} aria-hidden="true" />
      </button>
      {visible &&
        createPortal(
          <div
            ref={menu}
            className="pages-highlight-menu"
            style={position}
            role="menu"
            aria-label="Highlight color"
            onKeyDown={keys}
          >
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitemradio"
                aria-checked={current === color}
                aria-label={label(color)}
                title={label(color)}
                className="highlight-swatch"
                data-highlight={color}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => run(setHighlight, color)}
              />
            ))}
            <span className="toolbar-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              aria-label="Remove highlight"
              title="Remove highlight"
              className="highlight-remove"
              disabled={!present}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => run(clearHighlight)}
            >
              <Eraser size={16} aria-hidden="true" />
            </button>
          </div>,
          button.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}
