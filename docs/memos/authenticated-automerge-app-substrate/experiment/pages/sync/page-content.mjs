import { admitPageChanges } from "../model/page-admission.mjs";
import { Refusal } from "./host.mjs";

/**
 * SyncHost `admit` hook for the Page document: the Page-body rules
 * (model/page-admission.mjs), run on what a sync message's changes would
 * write, before anything is stored. A refusal is never fatal and never blocks
 * the principal: a stale build or a client bug can send content an honest
 * person meant to write, as with `outdated_form` on the comments document.
 * The refusal's `rule` names the rule the changes broke, for counts.
 */
export function pageAdmission() {
  return (_conn, doc, live, _fresh, preview) => {
    if (doc.kind !== "page") return preview;
    const result = admitPageChanges(live, preview);
    if (!result.ok)
      throw Object.assign(new Refusal(result.reason.code, result.reason.message), {
        rule: result.reason.rule,
      });
    return preview;
  };
}
