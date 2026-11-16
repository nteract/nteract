import { ChevronDown, ChevronLeft, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import "./pane-header.css";

/** Shared chrome for document side panes; each pane owns its content and state. */
export function PaneHeader({ children, className = "" }) {
  return <div className={`pane-header ${className}`}>{children}</div>;
}

export function PaneBack({ children, onClick, buttonRef, className = "" }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`subtle-button pane-back ${className}`}
      onClick={onClick}
    >
      <ChevronLeft size={17} aria-hidden="true" />
      {children}
    </button>
  );
}

export function PaneNavigation({ position, item, onStep, className = "" }) {
  return (
    <>
      {position && (
        <span className={`pane-position ${className}`}>
          <b>{position.index}</b> of {position.total}
        </span>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label={`Previous ${item}`}
        disabled={!position || position.index <= 1}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Next ${item}`}
        disabled={!position || position.index >= position.total}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
    </>
  );
}

export function PaneExpand({ expanded = false, onClick, name, className = "" }) {
  const label = `${expanded ? "Narrow" : "Expand"} ${name}`;
  return (
    <button
      type="button"
      className={`icon-button pane-expand ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {expanded ? (
        <Minimize2 size={16} aria-hidden="true" />
      ) : (
        <Maximize2 size={16} aria-hidden="true" />
      )}
    </button>
  );
}

export function PaneClose({ onClick, label }) {
  return (
    <button type="button" className="icon-button" aria-label={label} onClick={onClick}>
      <X size={18} aria-hidden="true" />
    </button>
  );
}
