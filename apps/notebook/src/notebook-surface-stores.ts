/**
 * Headless slice of the notebook public surface: store, projection, and
 * preservation functions with no component (and therefore no CSS/asset)
 * imports, so it loads under plain node test runners.
 *
 * `notebook-surface.ts` exports the same symbols for browser consumers that
 * also need components; node-importable consumers (the cloud view-store
 * bridge and its tests) import this module instead. Both files re-export
 * the same `./lib` implementations, so there is no behavioral drift —
 * only a difference in what else comes along for the ride.
 */
export { shouldPreserveBootstrapProjection } from "./lib/bootstrap-preservation";
// Sourced from the store module directly: `./lib/notebook-cells` re-exports
// the same function through the `@/components/notebook` barrel, which pulls
// component CSS and breaks node loaders.
export { getCellIdsSnapshot } from "@/components/notebook/state/cell-store";
export { resetRuntimeStoresProjection } from "./lib/project-runtime-stores";
export { resetRuntimeState } from "./lib/runtime-state";
