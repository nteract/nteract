/** Every `recordStorage` a Page record may name that this build opens: plain
 * Automerge sync only. The Page host refuses any other mode with
 * "Unsupported Page record storage mode", unless the Page is deleted, and
 * the build receipt records this list as `record_storage`, so deployment can
 * refuse a release that would fail to open Pages a target already holds
 * (scripts/deployment/profiles.mjs). */
export const RECORD_STORAGE_MODES = Object.freeze(["automerge"]);

/** Plain history format and admission capabilities this build implements.
 * Deployment requires these for every target that may hold plain Pages. */
export const PLAIN_STORAGE_FORMATS = Object.freeze(["doc-store-v2-host-actor-prefix"]);
