import React, { useState } from "react";
import { RefreshCw } from "lucide-react";

export const SCHEMA_UNSUPPORTED =
  "This Page uses features this version doesn't support. Reload to update.";

/** Shown while the session's schema gate holds the Page read-only.
 * `reload` asks the tab's reload gate, which saves held Pages first and
 * resolves { ok: false, message } when it can't. */
export function SchemaNotice({ gate, reload }) {
  const [reloading, setReloading] = useState(false),
    [problem, setProblem] = useState("");
  if (gate?.editable !== false) return null;
  async function onReload() {
    setReloading(true);
    setProblem("");
    const result = await reload();
    if (!result?.ok) {
      setProblem(result?.cancelled ? "" : (result?.message ?? ""));
      setReloading(false);
    }
  }
  return (
    <div className="access-notice schema-notice" role="alert">
      <p>{SCHEMA_UNSUPPORTED}</p>
      <button type="button" className="primary" onClick={onReload} disabled={reloading}>
        <RefreshCw size={15} aria-hidden="true" />
        {reloading ? "Saving edits…" : "Reload"}
      </button>
      {problem && <p className="build-update-problem">{problem}</p>}
    </div>
  );
}
