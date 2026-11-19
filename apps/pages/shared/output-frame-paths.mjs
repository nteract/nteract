// The frame paths. The output Worker (output/worker.mjs) serves every path in
// OUTPUT_FRAME_PATHS; this viewer mounts OUTPUT_FRAME_PATH, which must be one
// of them. The build receipt records OUTPUT_FRAME_PATHS as
// `output_frame_paths` and OUTPUT_FRAME_PATH as `output_frame_path`.
//
// A frame path serves the frame document: the bootstrap
// (@nteract/output-frame/bootstrap), a fixed script that runs the frame
// runtime the page sends it. The path's version names the version of that
// document, not the port protocol; the port protocol is versioned in the boot
// message's `connect` field, and the runtime travels with the page, so a
// runtime or port protocol change needs no shell deploy and no new path.
//
// A change to the bootstrap document needs a new versioned path. That change
// keeps serving the previous path for at least one release, and the shell
// deploys before the viewer that mounts the new path.
//
// This module has no imports: the output Worker bundles it on its own.
export const OUTPUT_FRAME_PATH = "/frame/v2/";
export const OUTPUT_FRAME_PATHS = Object.freeze([OUTPUT_FRAME_PATH]);
