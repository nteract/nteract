import { useEffect, useRef } from "react";
import { CommentSelectionAffordance } from "nteract-elements";

const noop = () => undefined;

// Author identity colors — the same canonical colors used for cursors/edits.
const authors = [
  { name: "Kyle", color: "#2563eb", contrast: "#ffffff" },
  { name: "Ana", color: "#16a34a", contrast: "#ffffff" },
  { name: "Rin", color: "#f59e0b", contrast: "#1a1a1a" },
];

function AuthorScope({
  color,
  contrast,
  children,
}: {
  color: string;
  contrast: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={
        {
          "--comment-author-color": color,
          "--comment-author-contrast": contrast,
        } as React.CSSProperties
      }
    >
      {children}
    </span>
  );
}

// At rest: a small author-colored dot. It never opens on its own — hover or
// keyboard focus morphs it into the "Comment" pill.
export function Resting() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      {authors.map((a) => (
        <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="text-xs text-muted-foreground">{a.name}</span>
          <AuthorScope color={a.color} contrast={a.contrast}>
            <CommentSelectionAffordance onActivate={noop} />
          </AuthorScope>
        </div>
      ))}
    </div>
  );
}

// The open pill. The motion helper opens on pointerenter or focus; focusing the
// button plays the staged grow → spread → reveal exactly as keyboard reach would.
export function Open() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const btn = ref.current?.querySelector("button");
    btn?.focus();
    btn?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  }, []);
  return (
    <div ref={ref}>
      <AuthorScope color="#2563eb" contrast="#ffffff">
        <CommentSelectionAffordance onActivate={noop} />
      </AuthorScope>
    </div>
  );
}

// The shared highlight surface (comment-highlight.css) the affordance leads to:
// open threads keep the underline cue, resolved drops to a faint tint, and the
// pending range under an open composer reads dashed and tentative.
export function HighlightStates() {
  return (
    <div className="text-sm" style={{ maxWidth: 440, lineHeight: 1.7, display: "grid", gap: 10 }}>
      <p>
        Weekly revenue is aggregated by region, and{" "}
        <span className="comment-highlight">the outliers are winsorized at p99</span> before the
        trend fit.
      </p>
      <p>
        The loader now streams row groups, so{" "}
        <span className="comment-highlight comment-highlight-resolved">
          memory stays flat on large files
        </span>{" "}
        even for the full-year extract.
      </p>
      <p>
        For the next run we should{" "}
        <span className="comment-highlight comment-highlight-pending">
          pin the schema version explicitly
        </span>
        <AuthorScope color="#2563eb" contrast="#ffffff">
          <CommentSelectionAffordance onActivate={noop} />
        </AuthorScope>
      </p>
      <div className="text-xs text-muted-foreground" style={{ display: "flex", gap: 16 }}>
        <span>open · underlined</span>
        <span>resolved · faint tint</span>
        <span>pending · dashed, with affordance</span>
      </div>
    </div>
  );
}
