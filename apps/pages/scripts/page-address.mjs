// A Page's address in a browser smoke. Once a Page is open, the viewer adds
// the slug its title gives (viewer/address-slug.mjs) about a second after the
// title is known, so an address a smoke checks may show `/p/<id>` or
// `/p/<id>/<slug>` depending on timing. Smokes that test something else match
// either; navigation-smoke.mjs checks the slug itself.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for Page `pageId`'s full URL at `origin`, with or without a
 * slug, followed by exactly `fragment` (`#anchor`, or "" for none). */
export const pageAddress = (origin, pageId, fragment = "") =>
  new RegExp(`^${escape(origin)}/p/${escape(pageId)}(?:/[A-Za-z0-9_-]{1,80})?${escape(fragment)}$`);

/** The Page id in a `/p/<id>` or `/p/<id>/<slug>` URL. */
export const pageIdOf = (url) => new URL(url).pathname.split("/")[2];
