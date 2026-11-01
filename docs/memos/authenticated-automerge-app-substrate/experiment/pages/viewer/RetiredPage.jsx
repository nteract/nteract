import React from "react";
import { Download } from "lucide-react";

export const RETIRED_COPY =
  "The copy this browser kept is no longer shown. It was moved to this device's recovery archive.";

/** Shown in place of a Page the host refused (`session.revoked`) or reports
 * deleted (`session.deleted`). Nothing from the Page renders here, its title
 * included. The download exports the live replica's copy when this tab held
 * one, otherwise the latest recovery record. */
export function RetiredPage({ session, recoveries, onDownload, onHome }) {
  const live = !!session.closedRecovery;
  const record = recoveries.at(-1);
  return (
    <main className="welcome retired-page">
      <div className="access-notice retired-notice" role="status">
        <h1>{session.deleted ? "This Page was deleted" : "You no longer have access"}</h1>
        <p>
          {session.deleted
            ? "It was deleted permanently and can't be opened again."
            : "This account can't open this Page now. Ask its owner to share it again."}
        </p>
        {(live || record) && <p>{RETIRED_COPY}</p>}
        {(live || record) && (
          <button type="button" onClick={() => onDownload(live ? undefined : record)}>
            <Download size={15} aria-hidden="true" /> Download local copy
          </button>
        )}
        <button type="button" className="subtle-button" onClick={onHome}>
          Back to your Pages
        </button>
      </div>
    </main>
  );
}
