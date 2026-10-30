import { useEffect, useRef, useState } from "react";
import { FileText, Home, Plus } from "lucide-react";
import { pagePath, isPlainNavigation } from "../shared/routes.mjs";
import { createPageInSpace, listSpacePages, spaceTree } from "./spaces.mjs";

/** One Space: its home Page, then its Pages as a tree. Owner-only for now.
 * Loading and errors stay local and simple here; the Space view moves to the
 * shared RxJS store pattern when the Pages state-machine tooling lands. */
export function SpaceView({ tool, spaceId, onOpen, onBack, onCreated }) {
  const [space, setSpace] = useState(null);
  const [pages, setPages] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    setSpace(null);
    setPages(null);
    setError("");
    Promise.all([tool("get_space", { space_id: spaceId }), listSpacePages(tool, spaceId)]).then(
      ([loaded, listed]) => {
        if (revision !== generation.current) return;
        setSpace(loaded);
        setPages(listed);
      },
      (cause) => {
        if (revision === generation.current) setError(cause.message);
      },
    );
    return () => {
      generation.current++;
    };
  }, [spaceId]);
  async function create() {
    setCreating(true);
    setError("");
    try {
      const created = await createPageInSpace(tool, spaceId);
      onCreated?.();
      await onOpen(created.page_id);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setCreating(false);
    }
  }
  const link = (page, children) => (
    <a
      className="page-card"
      href={pagePath(page.page_id)}
      onClick={(event) => {
        if (!isPlainNavigation(event)) return;
        event.preventDefault();
        void onOpen(page.page_id);
      }}
    >
      {children}
    </a>
  );
  const tree = pages ? spaceTree(pages) : null;
  return (
    <main className="page-library space-view">
      <div className="library-heading">
        <div>
          <button className="subtle-button space-back" onClick={onBack}>
            All pages
          </button>
          <h1>{space?.title ?? "Space"}</h1>
          {space?.description && <p className="muted space-description">{space.description}</p>}
        </div>
        <div className="library-actions">
          <button className="primary" onClick={create} disabled={creating || !space}>
            <Plus size={18} aria-hidden="true" /> New Page in this Space
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!tree && !error && <p role="status">Loading…</p>}
      {tree && (
        <ul className="page-list page-cards" aria-label={`Pages in ${space?.title ?? "Space"}`}>
          {tree.map(({ page, depth }) => (
            <li
              className={page.home ? "page-row space-home" : "page-row"}
              key={page.page_id}
              style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
            >
              {link(
                page,
                <>
                  {page.home ? (
                    <Home size={19} aria-hidden="true" />
                  ) : (
                    <FileText size={19} aria-hidden="true" />
                  )}
                  <span className="page-card-title">{page.title || "Untitled"}</span>
                  {page.home && <span className="page-card-meta">Home</span>}
                </>,
              )}
            </li>
          ))}
          {tree.length < 2 && <li className="muted space-empty">No other Pages yet.</li>}
        </ul>
      )}
    </main>
  );
}

/** Space › parent Pages above an open Page's title. */
export function Breadcrumbs({ crumbs, onOpenSpace, onOpenPage }) {
  if (!crumbs?.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.space_id ?? crumb.page_id}>
            <a
              href={crumb.kind === "space" ? `/s/${crumb.space_id}` : pagePath(crumb.page_id)}
              onClick={(event) => {
                if (!isPlainNavigation(event)) return;
                event.preventDefault();
                if (crumb.kind === "space") onOpenSpace(crumb.space_id);
                else void onOpenPage(crumb.page_id);
              }}
            >
              {crumb.title || "Untitled"}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
