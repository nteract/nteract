// The frame protocol paths. The output Worker (output/worker.mjs) serves every
// path in OUTPUT_FRAME_PATHS; this viewer mounts OUTPUT_FRAME_PATH, which must
// be one of them. The build receipt records OUTPUT_FRAME_PATHS as
// `output_frame_paths`.
//
// The output Worker and the Pages Worker deploy separately, so a viewer can
// meet an older or newer shell for a while. A change that breaks the frame
// protocol adds a new versioned path here, keeps serving the previous one for
// at least one release, and deploys the shell before the viewer that needs it.
//
// This module has no imports: the output Worker bundles it on its own.
export const OUTPUT_FRAME_PATH = "/frame/v2/";
export const OUTPUT_FRAME_PATHS = Object.freeze([OUTPUT_FRAME_PATH]);
