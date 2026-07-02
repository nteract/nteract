import { CommentMarkIcon } from "nteract-elements";

// The mark is the author's voice: bubble stroke inherits currentColor from the
// surrounding text (muted at rest, foreground on hover), the inner dot carries
// the author's identity color via --comment-author-color.
const authors = [
  { name: "Kyle", color: "#2563eb" },
  { name: "Ana", color: "#16a34a" },
  { name: "Rin", color: "#f59e0b" },
];

export function AuthorVoices() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      {authors.map((a) => (
        <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            className="text-muted-foreground"
            style={{ "--comment-author-color": a.color } as React.CSSProperties}
          >
            <CommentMarkIcon width={20} height={20} />
          </span>
          <span className="text-xs text-muted-foreground">{a.name}</span>
        </div>
      ))}
    </div>
  );
}

// Stroke follows the text color of the surface it sits on: muted in a quiet
// gutter, foreground when the control is hot.
export function StrokeContexts() {
  const scope = { "--comment-author-color": "#2563eb" } as React.CSSProperties;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, ...scope }}>
      <span
        className="text-muted-foreground"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        <CommentMarkIcon width={20} height={20} />
        <span className="text-xs">muted (gutter at rest)</span>
      </span>
      <span className="text-foreground" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <CommentMarkIcon width={20} height={20} />
        <span className="text-xs">foreground (hover/active)</span>
      </span>
    </div>
  );
}

export function Sizes() {
  const scope = { "--comment-author-color": "#2563eb" } as React.CSSProperties;
  return (
    <div
      className="text-foreground"
      style={{ display: "flex", alignItems: "end", gap: 16, ...scope }}
    >
      <CommentMarkIcon width={16} height={16} />
      <CommentMarkIcon width={20} height={20} />
      <CommentMarkIcon width={24} height={24} />
      <CommentMarkIcon width={32} height={32} />
    </div>
  );
}
