// The body of a /pages grid card. It always renders a placeholder: a muted
// Page (or home) icon centered in the card body. The body is decoration; the
// card's link text is the Page title.
//
// It accepts a `card` prop and ignores it. The prop's shape is the preview
// JSON model/page-preview.mjs builds ({ title, blocks: [{ id, content }] },
// each node [tag, attrs, ...children]). The card is one link, so anything
// rendered from that JSON here has to drop the preview's own links.
import { FileText, Home } from "lucide-react";

/**
 * @param {{ card?: { title?: string, blocks: Array<{ id: string, content: unknown[] }> } | null,
 *           home?: boolean }} props
 */
export function PageCardPreview({ home = false }) {
  const Icon = home ? Home : FileText;
  return (
    <div className="index-card-preview" aria-hidden="true">
      <Icon className="index-card-placeholder" size={36} strokeWidth={1.5} />
    </div>
  );
}
