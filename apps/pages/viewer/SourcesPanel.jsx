import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Database, History, Search, X } from "lucide-react";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { sourceTime } from "./source-line.mjs";
import { sourceMediaLabel, sourcesPanelStore } from "./sources-panel-store.mjs";
import { useStore } from "./store.mjs";
import "./sources-panel.css";

const sourceNotices = {
  unknown: "Looking for sources…",
  unreachable: "Sources couldn't be reached. Reconnect to load them.",
  unreadable:
    "This version of Pages can't read this Page's sources format. Update Pages to inspect its sources.",
  unserved: "This host doesn't support sources inspection for this version of Pages.",
};

function Timestamp({ value }) {
  const time = sourceTime(value, Date.now());
  return <time dateTime={time.dateTime ?? undefined}>{time.exact}</time>;
}

function Writer({ value }) {
  return (
    <>
      <span>{value?.displayName || "Unknown writer"}</span>
      {value?.agent?.name && (
        <small title="Agent labels are provided by the client.">
          via {value.agent.name} · client-provided
        </small>
      )}
    </>
  );
}

/** Same dock/sheet geometry as comments; mounted only during inspection.
 * This component owns selection and search, never a second document copy. */
export function SourcesPanel({ session, selection, onClose, onReveal }) {
  const inspector = useMemo(() => sourcesPanelStore(session), [session]);
  const value = useStore(inspector.store);
  useEffect(() => inspector.start(), [inspector]);
  const [selected, setSelected] = useState(selection?.id ?? null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("uses");
  const dialog = useRef(null);
  const [mobile, setMobile] = useState(() => matchMedia(COMMENTS_SHEET_QUERY).matches);
  useEffect(() => {
    setSelected(selection?.id ?? null);
    setQuery("");
    setTab("uses");
  }, [selection]);
  useEffect(() => {
    const media = matchMedia(COMMENTS_SHEET_QUERY);
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    if (element.open) element.close();
    if (mobile) element.showModal();
    else element.show();
    (focused?.isConnected ? focused : element.querySelector("button"))?.focus({
      preventScroll: true,
    });
    return () => element.close();
  }, [mobile]);

  const source =
    value.sources.find((item) => item.source_id === selected) ??
    (selected ? null : value.sources[0]);
  const unavailable = source && source.availability !== "available";
  const incomplete = value.unresolvedViews.length > 0 || value.unreadableBlocks > 0;
  const results = value.sources.filter((item) =>
    `${item.name} ${item.source_id} ${sourceMediaLabel(item.media_type)}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  function choose(id) {
    setSelected(id);
    setTab("uses");
  }
  return (
    <dialog
      ref={dialog}
      id="page-sources"
      className={`comments sources-panel${mobile ? " comments-sheet" : ""}`}
      aria-labelledby="sources-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        if (mobile && event.target === dialog.current) onClose();
      }}
    >
      <header className="comments-heading">
        <h2 id="sources-title">
          <Database size={17} aria-hidden="true" /> Sources
        </h2>
        <button className="icon-button" aria-label="Close sources panel" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="sources-panel-body">
        <p className="sources-intro">The files behind this Page, and what reads them.</p>
        {value.answer !== "known" && (
          <p role="status" className="sources-notice">
            {sourceNotices[value.answer]}
          </p>
        )}
        {value.unreadableSources > 0 && (
          <p className="sources-notice">Some source details couldn't be read.</p>
        )}
        {value.sources.length > 0 ? (
          <>
            <label className="sources-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Find a source"
                placeholder="Find a source…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <nav className="sources-inventory" aria-label="Page sources">
              {results.map((item) => (
                <button
                  key={item.source_id}
                  className="source-row"
                  aria-pressed={source?.source_id === item.source_id}
                  onClick={() => choose(item.source_id)}
                >
                  <Database size={16} aria-hidden="true" />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.availability === "unreadable"
                        ? "Unreadable source"
                        : item.availability === "missing"
                          ? "Unavailable source"
                          : sourceMediaLabel(item.media_type)}{" "}
                      · {item.uses.length} {item.uses.length === 1 ? "connection" : "connections"}
                      {incomplete ? " found" : ""}
                    </small>
                  </span>
                </button>
              ))}
              {results.length === 0 && <p className="muted">No matching sources.</p>}
            </nav>
          </>
        ) : (
          value.answer === "known" && (
            <div className="sources-empty">
              <Database size={28} aria-hidden="true" />
              <h3>No sources yet</h3>
              <p>Named sources added to this Page will appear here.</p>
            </div>
          )
        )}
        {incomplete && (
          <p className="sources-notice" role="status">
            Connections are incomplete.{" "}
            {value.unresolvedViews.length > 0
              ? `${value.unresolvedViews.length} placed view${value.unresolvedViews.length === 1 ? " has" : "s have"} not been read. `
              : ""}
            {value.unreadableBlocks > 0 ? "Some Page content couldn't be inspected. " : ""}More
            sources may be in use.
          </p>
        )}
        {selected && !source && value.answer === "known" && (
          <p className="sources-notice">
            This source is no longer available on this Page. Choose another source above.
          </p>
        )}
        {source && (
          <section className="source-inspector" aria-label="Source details">
            <h3>{source.name}</h3>
            <p className="source-id">{source.source_id}</p>
            {unavailable ? (
              <p className="sources-notice">
                {source.availability === "unreadable"
                  ? "This source's details couldn't be read. Its connections are listed below."
                  : value.answer === "known"
                    ? "This source isn't available on this Page. Its connections are listed below."
                    : "This source hasn't been loaded. Its connections are listed below."}
              </p>
            ) : (
              <>
                <p className="source-type" title={source.media_type}>
                  {sourceMediaLabel(source.media_type)} · version {source.source_revision}
                </p>
                <dl className="source-facts">
                  <div>
                    <dt>{source.source_revision === "1" ? "Added" : "Refreshed"}</dt>
                    <dd>
                      <Timestamp value={source.producer.at} />
                    </dd>
                  </div>
                  <div>
                    <dt>Set by</dt>
                    <dd>
                      <Writer value={source.producer.by} />
                    </dd>
                  </div>
                </dl>
              </>
            )}
            <div className="source-sections" role="group" aria-label="Source sections">
              <button aria-pressed={tab === "uses"} onClick={() => setTab("uses")}>
                Connections
              </button>
              {!unavailable && (
                <button aria-pressed={tab === "history"} onClick={() => setTab("history")}>
                  <History size={14} aria-hidden="true" /> Versions
                </button>
              )}
            </div>
            {tab === "uses" || unavailable ? (
              <>
                <h4>Used on this Page · {source.uses.length}</h4>
                {source.uses.length === 0 && (
                  <p className="muted">
                    {incomplete
                      ? "No connections found yet."
                      : "No placed tables or views read this source."}
                  </p>
                )}
                {source.uses.map((use) => (
                  <button
                    className="source-use"
                    key={use.key}
                    onClick={() => {
                      onReveal(use, { close: mobile });
                    }}
                  >
                    <span>
                      <strong>{use.title}</strong>
                      <small>
                        {use.type}
                        {use.input ? ` · ${use.input}` : ""}
                      </small>
                      <small>
                        {use.revision ? `Pinned · version ${use.revision}` : "Follows latest"}
                        {use.revision &&
                        !unavailable &&
                        !source.history.some((version) => version.revision === use.revision)
                          ? " · no longer retained"
                          : ""}
                      </small>
                    </span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                ))}
              </>
            ) : (
              <>
                <h4>Retained versions</h4>
                {source.history_truncated && (
                  <p className="muted">Older versions are no longer retained.</p>
                )}
                <ol className="source-history">
                  {[...source.history].reverse().map((version) => (
                    <li key={version.revision}>
                      <strong>
                        Version {version.revision}
                        {version.revision === source.source_revision ? " · current" : ""}
                      </strong>
                      <small>
                        <Timestamp value={version.at} />
                      </small>
                      <small>
                        {sourceMediaLabel(version.media_type)} · {version.name}
                      </small>
                      <small>
                        <Writer value={version.by} />
                      </small>
                      {source.uses.some((use) => use.revision === version.revision) && (
                        <small className="source-pin">A connection is pinned here</small>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
      </div>
    </dialog>
  );
}
