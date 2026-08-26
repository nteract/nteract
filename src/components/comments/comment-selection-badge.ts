import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Class string for the "comment on selection" affordance, taken straight from the
 * shared badge primitive (`components/ui/badge.tsx`) so the affordance reads as the
 * same badge used everywhere else: `rounded-md`, `text-xs`, `font-medium`, on the
 * primary fill. The fixed outer affordance button owns the focus-visible ring so
 * that ring remains usable while this inner visual morphs.
 *
 * Lives in its own module because both planes need it: the React
 * rendered-markdown plane (`CommentSelectionAffordance`) and the CodeMirror source
 * plane, which builds the same markup imperatively in
 * `apps/notebook/src/lib/source-comment-extension.ts`.
 */
export const COMMENT_SELECTION_BADGE_CLASS = cn(
  badgeVariants(),
  "comment-affordance-badge select-none whitespace-nowrap",
);
