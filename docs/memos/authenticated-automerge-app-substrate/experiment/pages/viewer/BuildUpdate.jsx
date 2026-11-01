import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { observeResponses, request } from "./request.mjs";
import { BuildMonitor, reloadGate } from "./build-freshness.mjs";
import { EDITOR_UNAVAILABLE } from "./editor-loader.mjs";
import "./build-update.css";

// One monitor per tab. It outlives Page sessions: a deploy can land while the
// library is showing, and a raised protocol floor applies to every Page.
export const buildMonitor = new BuildMonitor({
  fetchAdvertisement: () => request("/health", { cache: "no-store" }, { timeoutMs: 10_000 }),
});
observeResponses(buildMonitor.observeHeaders);

function downloadMarkdown({ pageId, title, markdown }) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[^\w .-]+/g, "").trim() || pageId}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Pages" is also what people call their documents, so the banner names the
// app as the app.
export const BUILD_UPDATE_MESSAGES = Object.freeze({
  available: "App updated. Reload to use the latest version.",
  required: "App updated. This tab can't edit until you reload.",
});

/** principal: the signed-in account, so Open is offered only for its Pages.
 * onOpenPage(pageId) opens a Page in this tab. editorUnavailable: the editor
 * chunk failed to load, so this tab can't open Pages until it reloads. */
export function BuildUpdate({ session, principal, onOpenPage, editorUnavailable = false }) {
  const { state } = useSyncExternalStore(buildMonitor.subscribe, buildMonitor.getSnapshot);
  const [reloading, setReloading] = useState(false),
    [outcome, setOutcome] = useState(null),
    [downloaded, setDownloaded] = useState(() => new Set()),
    [acknowledged, setAcknowledged] = useState(false);
  const required = state === "required";
  // A newer build usually explains a missing editor chunk; this tab can't edit
  // until it reloads either way.
  const blocking = required || (editorUnavailable && state !== "current");
  useEffect(() => {
    buildMonitor.start();
  }, []);
  useEffect(() => {
    // This viewer's protocol is retired: keep what it already accepted saving,
    // but take no new edits, on this Page or any Page opened after it.
    if (required) session?.pauseEdits("protocol");
  }, [required, session]);
  // Opening another Page changes what Reload covers; ask again on the next click.
  useEffect(() => setOutcome(null), [session]);
  if (state === "current" && !editorUnavailable) return null;
  async function reload(options) {
    setReloading(true);
    setOutcome(null);
    const result = await reloadGate.reload(options);
    if (!result.ok) {
      setOutcome(result.cancelled ? null : result);
      setDownloaded(new Set());
      setAcknowledged(false);
      setReloading(false);
    }
  }
  function discardAndReload() {
    void reload({ discard: outcome.pages.map((page) => page.key) });
  }
  const pages = outcome?.pages ?? [];
  const canDiscard =
    acknowledged || (pages.length > 0 && pages.every((page) => downloaded.has(page.key)));
  // An optional update is information; a tab that can't edit is a warning.
  const warning = blocking || editorUnavailable;
  const message = blocking
    ? BUILD_UPDATE_MESSAGES.required
    : editorUnavailable
      ? EDITOR_UNAVAILABLE
      : BUILD_UPDATE_MESSAGES.available;
  const Icon = warning ? AlertTriangle : Info;
  return (
    <div
      className={warning ? "build-update build-update--required" : "build-update"}
      data-tone={warning ? "warning" : "info"}
      role={warning ? "alert" : "status"}
    >
      <span className="build-update-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="build-update-body">
        <div className="build-update-row">
          <p className="build-update-message">{message}</p>
          {!outcome?.reason && (
            <button type="button" onClick={() => reload()} disabled={reloading}>
              <RefreshCw size={14} aria-hidden="true" />
              {reloading ? "Saving edits…" : "Reload"}
            </button>
          )}
        </div>
        {outcome?.message && (
          <p
            className={
              outcome.reason === "checkpointed" ? "build-update-note" : "build-update-problem"
            }
          >
            {outcome.message}
          </p>
        )}
        {outcome?.reason === "checkpointed" && (
          <div className="build-update-actions">
            <button
              type="button"
              disabled={reloading}
              onClick={() => reload({ acceptCheckpoints: true })}
            >
              Reload anyway
            </button>
            {pages
              .filter((page) => page.account === principal)
              .map((page) => (
                <button
                  type="button"
                  key={page.key}
                  disabled={reloading}
                  onClick={() => onOpenPage(page.pageId)}
                >
                  Open {page.title}
                </button>
              ))}
          </div>
        )}
        {outcome?.reason === "unsaved" && (
          <div className="build-update-actions">
            {pages.map((page) => (
              <button
                type="button"
                key={page.key}
                onClick={() => {
                  downloadMarkdown(page);
                  setDownloaded((previous) => new Set(previous).add(page.key));
                }}
              >
                Download edits and comments (Markdown)
                {pages.length > 1 ? ` (${page.title})` : ""}
              </button>
            ))}
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />{" "}
              I don't need these edits
            </label>
            <button
              type="button"
              className="danger"
              disabled={reloading || !canDiscard}
              onClick={discardAndReload}
            >
              Discard unsaved edits and reload
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
