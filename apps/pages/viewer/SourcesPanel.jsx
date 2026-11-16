import { useEffect, useMemo, useRef, useState } from "react";
import { Observable, distinctUntilChanged, map } from "rxjs";
import { sourceSchemaStore } from "./source-schema-store.mjs";
import { SOURCE_PREVIEW_TYPES, sourcePreviewStore } from "./source-preview-store.mjs";
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  File,
  FileAudio,
  FileCode,
  FileDigit,
  History,
  Paintbrush,
  Puzzle,
  Search,
  Table2,
} from "lucide-react";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";
import { sourceTime } from "./source-line.mjs";
import { sourceMediaLabel, sourcesPanelStore } from "./sources-panel-store.mjs";
import { dataframeFrame, dataframeLifecycle } from "./wordgard-dataframes.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";
import { useStore } from "./store.mjs";
import { PaneBack, PaneClose, PaneExpand, PaneHeader, PaneNavigation } from "./PaneHeader.jsx";
import "./sources-panel.css";

const sourceNotices = {
  unknown: "Looking for sources…",
  unreachable: "Sources couldn't be reached. Reconnect to load them.",
  unreadable:
    "This version of Pages can't read this Page's sources format. Update Pages to inspect its sources.",
  unserved: "This host doesn't support sources inspection for this version of Pages.",
};

function SourceIcon({ mediaType }) {
  const Icon =
    {
      [PARQUET_MEDIA_TYPE]: Table2,
      "text/javascript": FileCode,
      "text/css": Paintbrush,
      "application/octet-stream": FileDigit,
      "audio/wav": FileAudio,
      "application/vnd.vegalite.v6+json": ChartNoAxesCombined,
      [ANYWIDGET_MEDIA_TYPE]: Puzzle,
    }[mediaType] ?? File;
  return <Icon size={16} aria-hidden="true" />;
}

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

/** Reuse the document table renderer and its cancellable lifecycle. Only the
 * selected Parquet source is held; filters and sorting remain local to Sift. */
function SourceTable({ session, source }) {
  const container = useRef(null);
  useEffect(() => {
    const frame = dataframeFrame({ title: "Source preview", media_type: PARQUET_MEDIA_TYPE });
    frame.header.remove();
    container.current.replaceChildren(frame.dom);
    const lifecycle = dataframeLifecycle({
      ...frame,
      attrs: {
        pageId: session.pageId,
        ...(source.kind === "attachment"
          ? { src: source.src }
          : { binding: { source_id: source.source_id } }),
        sources: session.pageSources,
      },
      park: 0,
    });
    lifecycle.connect();
    return () => lifecycle.disconnect();
  }, [session, source.source_id, source.kind, source.src]);
  return <div className="source-table-preview" ref={container} />;
}

function SourceSchema({ session, source }) {
  const resource = useMemo(
    () => sourceSchemaStore(session, source.source_id),
    [session, source.source_id],
  );
  const value = useStore(resource.store);
  useEffect(() => resource.start(), [resource]);
  if (value.name !== "ready")
    return (
      <p className="source-schema-status" role="status">
        {value.name === "loading"
          ? "Loading schema…"
          : value.message || "Schema isn't available for this source."}
      </p>
    );
  const { summary } = value;
  return (
    <section
      className="source-schema"
      aria-label="Table schema"
      data-source-revision={value.version.revision}
    >
      <h4>Schema</h4>
      <p>
        {summary.rows.toLocaleString()} rows · {summary.column_count.toLocaleString()} columns
      </p>
      <ul>
        {summary.columns.map((column) => (
          <li key={column.name}>
            <strong>{column.name}</strong>
            <code>{column.type}</code>
          </li>
        ))}
      </ul>
      {summary.columns_truncated && (
        <p>
          Showing {summary.columns.length} of {summary.column_count} columns.
        </p>
      )}
    </section>
  );
}

function SourceAudio({ bytes }) {
  const audio = useRef(null);
  useEffect(() => {
    const player = audio.current;
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    player.src = url;
    return () => {
      player.pause();
      player.removeAttribute("src");
      player.load();
      URL.revokeObjectURL(url);
    };
  }, [bytes]);
  return <audio ref={audio} controls preload="metadata" aria-label="Source audio preview" />;
}

function SourceFilePreview({ session, source }) {
  const resource = useMemo(
    () => sourcePreviewStore(session, source.source_id),
    [session, source.source_id],
  );
  const value = useStore(resource.store);
  useEffect(() => resource.start(), [resource]);
  if (value.name !== "ready")
    return (
      <p role="status" className="source-schema-status">
        {value.name === "loading" ? "Loading preview…" : value.message || "Preview unavailable."}
      </p>
    );
  const { preview } = value;
  return (
    <section
      className="source-file-preview"
      aria-label="Source preview"
      data-source-revision={value.version.revision}
    >
      <h4>
        {preview.kind === "text"
          ? "Source code"
          : preview.kind === "audio"
            ? "Audio"
            : "Binary preview"}
      </h4>
      {preview.kind === "audio" ? (
        <SourceAudio key={value.version.asset_id} bytes={preview.bytes} />
      ) : (
        <pre tabIndex={0} aria-label={preview.kind === "text" ? "Source code" : "Hex bytes"}>
          <code>{preview.kind === "text" ? preview.text : preview.hex}</code>
        </pre>
      )}
      <small>
        {preview.size.toLocaleString()} bytes
        {preview.truncated
          ? preview.kind === "text"
            ? " · preview truncated"
            : " · first 64 bytes shown"
          : ""}
      </small>
    </section>
  );
}

// Use the available pane width, including phone sheets and constrained expanded
// docks, rather than assuming the Expand button always creates enough room.
function SourcePreview({ session, source }) {
  const container = useRef(null);
  const [wide, setWide] = useState(null);
  useEffect(() => {
    const subscription = new Observable((subscriber) => {
      const element = container.current;
      subscriber.next(element.getBoundingClientRect().width);
      const observer = new ResizeObserver((entries) =>
        subscriber.next(entries[0].contentRect.width),
      );
      observer.observe(element);
      return () => observer.disconnect();
    })
      .pipe(
        map((width) => width >= 520),
        distinctUntilChanged(),
      )
      .subscribe(setWide);
    return () => subscription.unsubscribe();
  }, []);
  return (
    <div className="source-preview" ref={container}>
      {wide === null ? (
        <p className="source-schema-status">Loading preview…</p>
      ) : wide ? (
        <SourceTable session={session} source={source} />
      ) : source.kind === "attachment" ? (
        <p className="source-schema-status">
          Open a connection below to inspect this table in the document.
        </p>
      ) : (
        <SourceSchema session={session} source={source} />
      )}
    </div>
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
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef(null);
  const inventory = useRef(null);
  const backButton = useRef(null);
  const previousSelection = useRef(selected);
  useEffect(() => {
    if (
      selected &&
      !dialog.current?.querySelector(".pane-header")?.contains(document.activeElement)
    )
      backButton.current?.focus({ preventScroll: true });
    else if (previousSelection.current) {
      const row = inventory.current?.querySelector(
        `[data-source-id="${CSS.escape(previousSelection.current)}"]`,
      );
      (row ?? inventory.current?.querySelector("button"))?.focus({ preventScroll: true });
    }
    previousSelection.current = selected;
  }, [selected]);
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

  const source = value.sources.find((item) => item.source_id === selected);
  const attached = source?.kind === "attachment";
  const unavailable = source && source.availability !== "available";
  const incomplete = value.unresolvedViews.length > 0 || value.unreadableBlocks > 0;
  const searchable = value.sources.length > 1;
  const results = value.sources.filter(
    (item) =>
      !searchable ||
      `${item.name} ${item.source_id} ${sourceMediaLabel(item.media_type)}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const index = results.findIndex((item) => item.source_id === selected);
  const position = index >= 0 ? { index: index + 1, total: results.length } : null;
  function back() {
    setSelected(null);
    setTab("uses");
  }
  function choose(id) {
    setSelected(id);
    setTab("uses");
  }
  return (
    <dialog
      ref={dialog}
      id="page-sources"
      className={`comments sources-panel${mobile ? " comments-sheet" : expanded ? " comments-expanded" : ""}`}
      aria-label="Sources"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (selected) back();
        else onClose();
      }}
      onClick={(event) => {
        if (mobile && event.target === dialog.current) onClose();
      }}
    >
      <PaneHeader>
        {selected ? (
          <PaneBack buttonRef={backButton} onClick={back}>
            All sources
          </PaneBack>
        ) : (
          <h2>
            <Database size={17} aria-hidden="true" /> Sources
          </h2>
        )}
        {selected && (
          <PaneNavigation
            position={position}
            item="source"
            onStep={(by) => {
              const next = results[index + by];
              if (next) choose(next.source_id);
            }}
          />
        )}
        {!mobile && (
          <PaneExpand expanded={expanded} name="sources" onClick={() => setExpanded(!expanded)} />
        )}
        <PaneClose label="Close sources panel" onClick={onClose} />
      </PaneHeader>
      <div className="sources-panel-body">
        {value.answer !== "known" && (
          <p role="status" className="sources-notice">
            {sourceNotices[value.answer]}
          </p>
        )}
        {value.unreadableSources > 0 && (
          <p className="sources-notice">Some source details couldn't be read.</p>
        )}
        {!selected &&
          (value.sources.length > 0 ? (
            <>
              {searchable && (
                <label className="sources-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    aria-label="Find a source"
                    placeholder="Find a source…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              )}
              <nav ref={inventory} className="sources-inventory" aria-label="Page sources">
                {results.map((item) => (
                  <button
                    key={item.source_id}
                    className="source-row"
                    data-source-id={item.source_id}
                    onClick={() => choose(item.source_id)}
                  >
                    <SourceIcon mediaType={item.media_type} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.availability === "unreadable"
                          ? "Unreadable source"
                          : item.availability === "missing"
                            ? "Unavailable source"
                            : sourceMediaLabel(item.media_type)}{" "}
                        {item.kind === "attachment" ? "· Attached file " : ""}· {item.uses.length}{" "}
                        {item.uses.length === 1 ? "connection" : "connections"}
                        {incomplete ? " found" : ""}
                      </small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
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
                <p>Sources and attached tables added to this Page will appear here.</p>
              </div>
            )
          ))}
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
          <p className="sources-notice">This source is no longer available on this Page.</p>
        )}
        {source && (
          <section className="source-inspector" aria-label="Source details">
            <h3>{source.name}</h3>
            {!attached && <p className="source-id">Source ID: {source.source_id}</p>}
            {unavailable ? (
              <p className="sources-notice">
                {source.availability === "unreadable"
                  ? "This source's details couldn't be read. Its connections are listed below."
                  : value.answer === "known"
                    ? "This source isn't available on this Page. Its connections are listed below."
                    : "This source hasn't been loaded. Its connections are listed below."}
              </p>
            ) : attached ? (
              <p className="source-type">
                {sourceMediaLabel(source.media_type)} · Attached file. This table uses a fixed file
                and doesn't follow source updates.
              </p>
            ) : (
              <>
                <p className="source-type" title={source.media_type}>
                  {sourceMediaLabel(source.media_type)}
                </p>
                <dl className="source-facts">
                  <div>
                    <dt>Revision</dt>
                    <dd>{source.source_revision}</dd>
                  </div>
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
            {!unavailable && source.media_type === PARQUET_MEDIA_TYPE && (
              <SourcePreview key={source.source_id} session={session} source={source} />
            )}
            {!unavailable && SOURCE_PREVIEW_TYPES.includes(source.media_type) && (
              <SourceFilePreview key={source.source_id} session={session} source={source} />
            )}
            <div className="source-sections" role="group" aria-label="Source sections">
              <button aria-pressed={tab === "uses"} onClick={() => setTab("uses")}>
                Connections
              </button>
              {!unavailable && !attached && (
                <button aria-pressed={tab === "history"} onClick={() => setTab("history")}>
                  <History size={14} aria-hidden="true" /> Revisions
                </button>
              )}
            </div>
            {tab === "uses" || unavailable || attached ? (
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
                        {attached
                          ? "Attached file"
                          : use.revision
                            ? `Pinned · revision ${use.revision}`
                            : "Follows latest"}
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
                <h4>Retained revisions</h4>
                {source.history_truncated && (
                  <p className="muted">Older revisions are no longer retained.</p>
                )}
                <ol className="source-history">
                  {[...source.history].reverse().map((version) => (
                    <li key={version.revision}>
                      <strong>
                        Revision {version.revision}
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
