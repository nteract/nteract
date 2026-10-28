import { useEffect, useState } from "react";
import { UsersRound } from "lucide-react";
import { activityIdentity, pageActivity, progressPassages } from "./activity.mjs";

function Identity({ identity }) {
  const { name, driver, delegated } = activityIdentity(identity);
  return (
    <div className="activity-identity">
      <strong>{delegated ? driver : name}</strong>
      {delegated && <span className="muted">on behalf of {name}</span>}
    </div>
  );
}

export function PageActivity({ session, disclosure, onReveal }) {
  const [, update] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const paint = () => update((value) => value + 1);
    const stopPresence = session.watchPresence(paint);
    const timer = setInterval(paint, 1000);
    return () => {
      stopPresence();
      clearInterval(timer);
    };
  }, [session]);
  useEffect(() => {
    if (open) return session.observeChange(() => update((value) => value + 1));
  }, [session, open]);
  const { progress, peers } = pageActivity(session, Date.now(), { resolveSelections: open });
  const count = progress.length + peers.length;
  const passages = open ? progressPassages(session) : [];
  useEffect(() => {
    if (!count) setOpen(false);
  }, [count]);
  if (!count) return null;
  return (
    <details
      className="page-activity"
      ref={disclosure}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="subtle-button"
        aria-label={`Page activity, ${count} active ${count === 1 ? "session" : "sessions"}`}
        title="Page activity"
      >
        <UsersRound size={18} aria-hidden="true" />
        <span className="activity-count">{count}</span>
      </summary>
      <div className="activity-popover">
        <strong className="activity-heading">Page activity</strong>
        <ul>
          {progress.map((item) => (
            <li key={`progress:${item.progress_id}`}>
              <Identity identity={item} />
              <p>{item.message}</p>
              {passages
                .filter((passage) => passage.progress.progress_id === item.progress_id)
                .map((passage) => (
                  <button
                    key={passage.index}
                    className="activity-passage"
                    onClick={() => onReveal?.(passage)}
                  >
                    <span>Show passage</span>
                    <q>{passage.quote}</q>
                  </button>
                ))}
            </li>
          ))}
          {peers.map((peer) => (
            <li key={`peer:${peer.id}`}>
              <Identity identity={peer.profile ?? { displayName: peer.displayName }} />
              <p className="muted">
                {peer.selection?.status === "attached"
                  ? peer.selection.kind === "selection"
                    ? "Text selected"
                    : "Cursor in this Page"
                  : "Selection in this Page"}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
