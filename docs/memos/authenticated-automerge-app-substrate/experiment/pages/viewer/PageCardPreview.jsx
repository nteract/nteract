// The body of a /pages grid card.
//
// `card` is where a Page's content preview plugs in: the same JSON
// model/page-preview.mjs builds for the boot preview ({ title, blocks: [{ id,
// content }] }, each node [tag, attrs, ...children]), rendered through
// viewer/PagePreview.jsx's previewNodes and scaled down to the card. The card
// is one link, so a renderer here must drop the preview's own links.
//
// list_pages carries no preview yet, so no caller passes `card` and every
// card shows the placeholder: a muted icon centered in the card body. The
// body is decoration; the card's link text is the Page title.
import { FileText, Home } from "lucide-react";

/**
 * @param {{ card?: { title?: string, blocks: Array<{ id: string, content: unknown[] }> } | null,
 *           home?: boolean }} props
 */
export function PageCardPreview({ card = null, home = false }) {
  // Until a renderer lands, a card with content still shows the placeholder.
  void card;
  const Icon = home ? Home : FileText;
  return (
    <div className="index-card-preview" aria-hidden="true">
      <Icon className="index-card-placeholder" size={36} strokeWidth={1.5} />
    </div>
  );
}
