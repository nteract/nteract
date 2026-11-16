import { useEffect, useMemo, useState } from "react";
import { Database } from "lucide-react";
import { useStore } from "./store.mjs";
import { sourceLine, sourceLineClock } from "./source-line.mjs";

function SourceTime({ source }) {
  const { time, action } = source;
  const exact = `${action === "added" ? "Added" : "Refreshed"} ${time.exact}`;
  return (
    <time dateTime={time.dateTime ?? undefined} title={exact} aria-label={time.exact}>
      {time.label}
    </time>
  );
}

const SourceIcon = () => <Database size={13} strokeWidth={1.5} aria-hidden="true" />;

/** Read-only metadata, outside the document's editable/commentable body. */
export function SourcesLineView({ value, onOpen, open = false }) {
  if (!value) return null;
  const Name = onOpen ? "button" : "span";
  const trigger = (id) =>
    onOpen
      ? {
          type: "button",
          "aria-expanded": open,
          "aria-controls": "page-sources",
          onClick: (event) => onOpen(id, event.currentTarget),
        }
      : {};
  return (
    <div className="sources-line" role="group" aria-label="Sources" data-source-count={value.count}>
      {value.entries.length > 0 && (
        <ul className="sources-line-entries">
          {value.entries.map((source) => (
            <li key={source.id} className="sources-line-entry">
              <Name className="sources-line-name" title={source.name} {...trigger(source.id)}>
                <SourceIcon />
                <span>{source.name}</span>
              </Name>
              <span aria-hidden="true">·</span>
              <span className="sources-line-age">
                {source.action} <SourceTime source={source} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {value.count >= 3 && (
        <div className="sources-line-summary">
          <Name className="sources-line-name" {...trigger(null)}>
            <SourceIcon />
            <span>{value.count} sources</span>
          </Name>
          <span>
            · newest <SourceTime source={value.newest} />
          </span>
          <span>
            · oldest <SourceTime source={value.oldest} />
          </span>
        </div>
      )}
    </div>
  );
}

export function SourcesLine({ session, onOpen, open }) {
  const sources = session.pageSources;
  const readable = useMemo(
    () => ({ state$: sources.sources$, snapshot: () => sources.snapshot() }),
    [sources],
  );
  const snapshot = useStore(readable);
  const populated = Object.keys(snapshot).length > 0;
  const [now, setNow] = useState(Date.now);
  // The existing lookup machine finds a first source created while this
  // Page is open, or reads the cached sources document on an offline open.
  useEffect(() => session.sources.demand(), [session]);
  useEffect(() => {
    if (!populated) return;
    const subscription = sourceLineClock().subscribe(setNow);
    return () => subscription.unsubscribe();
  }, [populated]);
  return <SourcesLineView value={sourceLine(snapshot, now)} onOpen={onOpen} open={open} />;
}
