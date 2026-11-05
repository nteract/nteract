// The refusal for content an earlier build stored in a form this build
// doesn't read: a block without rich text, a Page whose comments still live
// in the Page document, a host record without its comments document name. Every
// stored Page was rewritten to the current forms before these readers were
// removed, so meeting one means the data didn't come through that rewrite.
// Readers refuse rather than guess at it.

export const STORED_FORM_UNSUPPORTED = "stored_form_unsupported";

/** `what` names the stored thing: "this Page's comments". */
export function storedFormUnsupported(what) {
  return Object.assign(
    Error(`Pages can't read ${what}, stored in a form from an earlier version of Pages.`),
    { status: 409, code: STORED_FORM_UNSUPPORTED },
  );
}
