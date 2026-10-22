import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Pencil, Unlink, X } from "lucide-react";
import { linkDestination } from "./rich-links.mjs";
import "./link-popover.css";

export function LinkPopover({ view, target, editable, editing, onEdit, onChange, onClose }) {
  const element = useRef(null);
  const [href, setHref] = useState(target.attrs.href);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 12, top: 12, visibility: "hidden" });
  const destination = linkDestination(target.attrs.href, location.href);
  const positioned = position.visibility !== "hidden";
  useEffect(() => {
    setHref(target.attrs.href);
    setError("");
  }, [target.attrs.href]);
  useLayoutEffect(() => {
    if (!positioned) return;
    const control = element.current?.querySelector(
      editing ? "input" : ".link-popover-actions a, .link-popover-actions button",
    );
    control?.focus({ preventScroll: true });
    if (editing) control?.select();
  }, [editing, positioned]);
  useLayoutEffect(() => {
    const place = () => {
      if (!element.current || view.isDestroyed) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? innerWidth) - 24;
      const bottom = top + (viewport?.height ?? innerHeight) - 24;
      const anchor = view.coordsAtPos(target.from);
      const bounds = element.current.getBoundingClientRect();
      setPosition({
        left: Math.max(left, Math.min(anchor.left, right - bounds.width)),
        top: Math.max(top, Math.min(anchor.bottom + 8, bottom - bounds.height)),
      });
    };
    const observer = new ResizeObserver(place);
    observer.observe(element.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [view, target]);
  useEffect(() => {
    const outside = (event) => {
      if (!element.current?.contains(event.target)) onClose(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  function change(next) {
    try {
      if (onChange(next)) onClose(true);
    } catch (problem) {
      setError(problem.message);
    }
  }
  return createPortal(
    <div
      ref={element}
      className="link-popover"
      style={position}
      role="dialog"
      aria-label="Link"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="link-popover-header">
        <span title={target.attrs.href}>{target.attrs.href}</span>
        <button type="button" aria-label="Close link menu" onClick={() => onClose(true)}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {editing && editable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            change(href.trim());
          }}
        >
          <label>
            Link address
            <input
              type="text"
              value={href}
              onChange={(event) => {
                setHref(event.target.value);
                setError("");
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={!!error}
            />
          </label>
          {error && (
            <p className="link-error" role="alert">
              {error}
            </p>
          )}
          <div className="link-popover-actions">
            <button type="submit">Save link</button>
            <button type="button" onClick={() => onClose(true)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="link-popover-actions">
          {destination && (
            <a href={destination} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" /> Open link
            </a>
          )}
          {editable && (
            <button type="button" onClick={onEdit}>
              <Pencil size={16} aria-hidden="true" /> Edit link
            </button>
          )}
          {editable && (
            <button type="button" onClick={() => change(null)}>
              <Unlink size={16} aria-hidden="true" /> Remove link
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
