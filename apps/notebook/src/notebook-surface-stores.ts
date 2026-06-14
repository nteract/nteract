/**
 * Temporary headless slice of the notebook public surface for runtime
 * execution/output projection reset.
 *
 * TODO: move this reset path with the runtime execution/output projection
 * failure store so cloud no longer needs a desktop-app headless facade.
 */
export { resetRuntimeStoresProjection } from "./lib/project-runtime-stores";
