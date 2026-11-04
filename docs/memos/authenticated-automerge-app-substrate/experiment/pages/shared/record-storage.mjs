/** Every `recordStorage` a Page record may name that this build opens. A Page
 * record without one is `local`. The Page host refuses any other mode with
 * "Unsupported Page record storage mode", and the build receipt records this
 * list as `record_storage`, so deployment can refuse a release that would fail
 * to open Pages a target already holds (scripts/deployment/profiles.mjs).
 * Adding a mode here declares that the Worker reads it; removing one breaks
 * every Page created with it. */
export const RECORD_STORAGE_MODES = Object.freeze(["local", "buffered", "automerge"]);

/** Plain history format and admission capabilities this build implements.
 * Deployment requires these for every target that may hold plain Pages. */
export const PLAIN_STORAGE_FORMATS = Object.freeze(["doc-store-v2-host-actor-prefix"]);
