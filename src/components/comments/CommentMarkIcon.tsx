import { type SVGProps } from "react";

/**
 * The nteract comment mark: a speech bubble with the author's own colored dot
 * inside. The bubble stroke inherits `currentColor` so it picks up the
 * surrounding text color (muted at rest, foreground on hover), while the dot
 * carries the author's identity color (`--comment-author-color`, the same token
 * the selection affordance uses) with a `--primary` fallback - so the mark is
 * the author's voice, not a generic action icon. Shared by the cell-gutter
 * "comment on outputs" button, the editor and rendered-markdown context menus,
 * and the inline composer header. The selection affordance itself stays a plain
 * dot; this icon is for surfaces where a label or icon company needs the mark to
 * read as "comment."
 */
export function CommentMarkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 5h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5L6 18.5V15H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <circle
        cx="11"
        cy="10"
        r="2.6"
        stroke="none"
        style={{ fill: "var(--comment-author-color, var(--primary, #2563eb))" }}
      />
    </svg>
  );
}
