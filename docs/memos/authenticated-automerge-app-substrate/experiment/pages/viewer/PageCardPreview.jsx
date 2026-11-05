// The body of a library grid card: a scaled, read-only rendering of the
// Page's card (model/page-card.mjs), or a muted Page (or home) icon while
// there is none to show. The body is decoration: the card's link text is
// the Page title, so the body is aria-hidden and takes no pointer events.
//
// The card's JSON renders through PagePreview.jsx's allowlist in its inert
// mode: the card is one link, so links render as text, a task checkbox as a
// drawn box, and images not at all (a card holds placeholders instead).
// The content lays out at a reading width and is scaled down with
// `transform: scale()` (style.css, .page-card-scale), so every card shows
// the same small type whatever its width.
//
// A card whose Page has images for the same `card_hash` draws them over the
// JSON (PageCardImage.jsx).
import { Fragment } from "react";
import { FileText, Boxes } from "lucide-react";
import { previewNodes } from "./PagePreview.jsx";
import { PageCardImage, cardImageOf } from "./PageCardImage.jsx";

/**
 * @param {{ card?: { blocks: Array<{ id: string, content: unknown[] }> } | null,
 *           home?: boolean }} props
 */
export function PageCardPreview({ card = null, home = false }) {
  if (!card?.blocks?.length) {
    const Icon = home ? Boxes : FileText;
    return (
      <div className="index-card-preview" aria-hidden="true">
        <Icon className="index-card-placeholder" size={36} strokeWidth={1.5} />
      </div>
    );
  }
  const image = cardImageOf(card);
  return (
    <div className="index-card-preview page-card-preview" aria-hidden="true">
      <div className="page-card-scale">
        <div className="page-card-doc">
          {card.blocks.map((block) => (
            <Fragment key={block.id}>
              {previewNodes(block.content, block.id, { inert: true })}
            </Fragment>
          ))}
        </div>
      </div>
      {image && <PageCardImage image={image} />}
    </div>
  );
}
