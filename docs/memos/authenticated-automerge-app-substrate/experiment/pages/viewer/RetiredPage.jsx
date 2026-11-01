import React from "react";
import { Download } from "lucide-react";
import { retiredCopies } from "./retired-copies.mjs";

export const RETIRED_COPY =
  "The copy this browser kept is no longer shown. It was moved to this device's recovery archive.";
export const RETIRING_COPY =
  "The copy this browser kept is no longer shown. It is being moved to this device's recovery archive.";
export const RETIRE_FAILED =
  "This browser couldn't move its copy to the recovery archive. Download it now, or try again.";

/** Shown in place of a Page the host refused (`session.revoked`) or reports
 * deleted (`session.deleted`). Nothing from the Page renders here, its title
 * included. The download bundles every copy this browser holds for the Page
 * (session.exportRecoveries): the stored checkpoint, other tabs' replicas,
 * earlier archives, and this tab's replica with its unsent comment drafts. */
export function RetiredPage({ session, recoveries, onDownload, onRetry, onHome }) {
  const copies = retiredCopies(session, recoveries);
  const failed = session.retireFailed;
  const status = failed
    ? RETIRE_FAILED
    : session.recoveryArchived || !session.closedRecovery
      ? RETIRED_COPY
      : RETIRING_COPY;
  return (
    <main className="welcome retired-page">
      <div className="access-notice retired-notice" role={failed ? "alert" : "status"}>
        <h1>{session.deleted ? "This Page was deleted" : "You no longer have access"}</h1>
        <p>
          {session.deleted
            ? "It was deleted permanently and can't be opened again."
            : "This account can't open this Page now. Ask its owner to share it again."}
        </p>
        {copies > 0 && <p>{status}</p>}
        {failed && session.retireProblem && <p className="muted">{session.retireProblem}</p>}
        {failed && (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
        {copies > 0 && (
          <button type="button" onClick={() => onDownload(undefined, { bundle: true })}>
            <Download size={15} aria-hidden="true" />
            {copies === 1 ? "Download local copy" : `Download ${copies} local copies`}
          </button>
        )}
        <button type="button" className="subtle-button" onClick={onHome}>
          Back to your Pages
        </button>
      </div>
    </main>
  );
}
