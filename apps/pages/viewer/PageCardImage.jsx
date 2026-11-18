// A grid card's image (worker/card-images.mjs): the Page's first screen as
// its owner's browser drew it, one per theme. Both <img> elements are in the
// card; CSS (card-image.css) shows the one for the current theme, and a
// lazily loaded image that isn't shown isn't fetched. The JSON card stays
// underneath, so an image that fails to load leaves it showing.
//
// The grid's first row (Library.jsx FIRST_SCREEN_CARDS) holds the library's largest
// paint, so its cards' shown image loads eagerly at high priority
// (`priority`). The hidden theme's image always stays lazy, so it is never
// fetched while hidden.
//
// `onLoaded(image, width, height)` hears each image's natural size once it
// loads; the owner's grid uses it to find images larger than a capture
// (card-shrink-offers.mjs).
import { useState, useSyncExternalStore } from "react";
import { themeStore } from "./theme.mjs";
import { CARD_PIXEL_HEIGHT, CARD_PIXEL_WIDTH } from "./card-raster.mjs";

const THEMES = ["light", "dark"];
// The card's 4:3 box (style.css, .index-card-preview) at the size a capture
// draws (card-raster.mjs). The attributes give the ratio before CSS applies;
// CSS sets the drawn size.
export const CARD_IMAGE_WIDTH = CARD_PIXEL_WIDTH;
export const CARD_IMAGE_HEIGHT = CARD_PIXEL_HEIGHT;

/** @param {{ image: { card_hash: string, light: string, dark: string }, priority?: boolean, onLoaded?: (image: { card_hash: string, light: string, dark: string }, width: number, height: number) => void }} props */
export function PageCardImage({ image, priority = false, onLoaded }) {
  // The hash whose images failed: a newer card tries again.
  const [failed, setFailed] = useState(null);
  const { resolved } = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getSnapshot,
  );
  if (failed === image.card_hash) return null;
  return THEMES.map((theme) => {
    const eager = priority && theme === resolved;
    return (
      <img
        key={theme}
        className="page-card-image"
        data-theme={theme}
        src={image[theme]}
        alt=""
        width={CARD_IMAGE_WIDTH}
        height={CARD_IMAGE_HEIGHT}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        decoding="async"
        draggable={false}
        onLoad={
          onLoaded &&
          ((event) =>
            onLoaded(image, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))
        }
        onError={() => setFailed(image.card_hash)}
      />
    );
  });
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
