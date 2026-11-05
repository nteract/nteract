// A grid card's image (worker/card-images.mjs): the Page's first screen as
// its owner's browser drew it, one per theme. Both <img> elements are in the
// card; CSS (card-image.css) shows the one for the current theme, and a
// lazily loaded image that isn't shown isn't fetched. The JSON card stays
// underneath, so an image that fails to load leaves it showing.
import { useState } from "react";

const THEMES = ["light", "dark"];

/** @param {{ image: { card_hash: string, light: string, dark: string } }} props */
export function PageCardImage({ image }) {
  // The hash whose images failed: a newer card tries again.
  const [failed, setFailed] = useState(null);
  if (failed === image.card_hash) return null;
  return THEMES.map((theme) => (
    <img
      key={theme}
      className="page-card-image"
      data-theme={theme}
      src={image[theme]}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(image.card_hash)}
    />
  ));
}

/** The card's image references, when they are this build's routes. */
export function cardImageOf(card) {
  const image = card?.image;
  if (!image || typeof image.card_hash !== "string") return null;
  const route =
    /^\/api\/pages\/[0-9a-f-]{36}\/card-image\/[0-9a-f]{64}-(light|dark)\.(webp|png|jpg)$/;
  return THEMES.every((theme) => typeof image[theme] === "string" && route.test(image[theme]))
    ? image
    : null;
}
