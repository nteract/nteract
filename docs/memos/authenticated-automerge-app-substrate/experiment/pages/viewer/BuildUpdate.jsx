import React, { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { observeResponses, request } from "./request.mjs";
import { BuildMonitor, reloadWhenSaved } from "./build-freshness.mjs";
import "./build-update.css";

// One monitor per tab. It outlives Page sessions: a deploy can land while the
// library is showing, and a raised protocol floor applies to every Page.
const monitor = new BuildMonitor({
  fetchAdvertisement: () => request("/health", { cache: "no-store" }, { timeoutMs: 10_000 }),
});
observeResponses(monitor.observeHeaders);

export function BuildUpdate({ session }) {
  const { state } = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  const [reloading, setReloading] = useState(false),
    [problem, setProblem] = useState("");
  const required = state === "required";
  useEffect(() => {
    monitor.start();
  }, []);
  useEffect(() => {
    // This viewer's protocol is retired: keep what it already accepted saving,
    // but take no new edits, on this Page or any Page opened after it.
    if (required) session?.pauseEdits(true);
  }, [required, session]);
  if (state === "current") return null;
  async function reload() {
    setReloading(true);
    setProblem("");
    const result = await reloadWhenSaved(session, { keepPaused: required });
    if (!result.ok) {
      setProblem(result.message);
      setReloading(false);
    }
  }
  return (
    <div
      className={required ? "build-update build-update--required" : "build-update"}
      role={required ? "alert" : "status"}
    >
      <p>
        {required
          ? "Pages was updated. This tab can't edit until you reload."
          : "Pages was updated. Reload to get the latest version."}
      </p>
      <button type="button" className="primary" onClick={reload} disabled={reloading}>
        <RefreshCw size={15} aria-hidden="true" />
        {reloading ? "Saving edits…" : "Reload"}
      </button>
      {problem && <p className="build-update-problem">{problem}</p>}
    </div>
  );
}
