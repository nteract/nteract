import { useEffect, useRef, useState } from "react";
import { FileText, RotateCcw, Trash2 } from "lucide-react";
import { pagePath, isPlainNavigation } from "../shared/routes.mjs";
import {
  confirmPurge,
  listTrash,
  previewPurge,
  purgeSummary,
  restorePage,
  retirePurgedPage,
  trashedDate,
} from "./trash.mjs";

/** Owner-only Trash. Opening a trashed Page shows a read-only preview.
 * `identity` is the signed-in account whose local copies a purge archives. */
export function TrashView({ tool, principal, identity, onOpen, onRestored, onPurged, onBack }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const generation = useRef(0);
  const load = async () => {
    const revision = ++generation.current;
    try {
      const listed = await listTrash(tool);
      if (revision === generation.current) setPages(listed);
    } catch (cause) {
      if (revision === generation.current) setError(cause.message);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [principal]);
  async function run(pageId, action) {
    setBusy(pageId);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(null);
    }
  }
  const restore = (page) =>
    run(page.page_id, async () => {
      await restorePage(tool, page.page_id, principal);
      setPreview(null);
      await onRestored(page.page_id);
      await load();
    });
  const review = (page) =>
    run(page.page_id, async () => {
      setPreview(await previewPurge(tool, page.page_id, principal));
    });
  const purge = () =>
    run(preview.page_id, async () => {
      await confirmPurge(tool, preview, principal);
      const pageId = preview.page_id;
      setPreview(null);
      // The host's copy is gone; this browser's copy moves to the recovery
      // archive. A failed archive is reported after the listing refreshes.
      let kept;
      try {
        await retirePurgedPage(identity, pageId);
      } catch (cause) {
        kept = cause;
      }
      await onPurged(pageId);
      await load();
      if (kept)
        throw Error(
          `The Page was deleted, but this browser couldn't move its copy to the recovery archive: ${kept.message}`,
        );
    });
  return (
    <main className="page-library trash-view">
      <div className="library-heading">
        <h1>Trash</h1>
        <button className="subtle-button" onClick={onBack}>
          Back to pages
        </button>
      </div>
      <p className="muted">
        Pages in Trash are hidden from collaborators. Restore a Page to bring it back with its
        comments and sharing. Pages stay here until you restore or delete them.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {pages === null && !error && <p role="status">Loading…</p>}
      {pages?.length === 0 && <p className="muted">Trash is empty.</p>}
      <ul className="page-list page-cards" aria-label="Pages in Trash">
        {(pages ?? []).map((page) => (
          <li className="page-row trash-row" key={page.page_id}>
            <a
              className="page-card"
              href={pagePath(page.page_id)}
              onClick={(event) => {
                if (isPlainNavigation(event)) {
                  event.preventDefault();
                  void onOpen(page.page_id);
                }
              }}
            >
              <FileText size={19} aria-hidden="true" />
              <span className="page-card-title">{page.title || "Untitled"}</span>
              <span className="page-card-meta">Trashed {trashedDate(page.trashed_at)}</span>
            </a>
            <button
              className="subtle-button"
              disabled={busy === page.page_id}
              onClick={() => restore(page)}
            >
              <RotateCcw size={16} aria-hidden="true" /> Restore
            </button>
            <button
              className="subtle-button danger"
              disabled={busy === page.page_id}
              onClick={() => review(page)}
            >
              <Trash2 size={16} aria-hidden="true" /> Delete permanently
            </button>
            {preview?.page_id === page.page_id && (
              <div className="access-notice purge-confirmation" role="alertdialog">
                <p>
                  <strong>Delete “{preview.title || "Untitled"}” permanently?</strong> This cannot
                  be undone.
                </p>
                <ul>
                  {purgeSummary(preview).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <button className="danger" disabled={busy === page.page_id} onClick={purge}>
                  Delete permanently
                </button>
                <button onClick={() => setPreview(null)}>Cancel</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
