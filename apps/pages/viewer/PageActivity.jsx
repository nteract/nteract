import { useEffect, useState } from "react";
import { UsersRound } from "lucide-react";
import { activityIdentity, pageActivity, progressPassages } from "./activity.mjs";

function Identity({ identity }) {
  const { name, driver, delegated } = activityIdentity(identity);
  return (
    <div className="activity-identity">
      <strong>
        {delegated ? driver : name}
        {identity.agent ? ` · ${identity.agent}` : ""}
      </strong>
      {delegated && <span className="muted">on behalf of {name}</span>}
    </div>
  );
}

const PRESENCE_STATE = { reading: "Reading", active: "Editing", idle: "Idle" };

/** How many sessions the activity control counts, as its accessible name says. */
export const activitySessions = (count) =>
  `${count} active ${count === 1 ? "session" : "sessions"}`;

/**
 * The agents and peers in this Page, repainted as presence arrives and as
 * leases age out. Passages and peer selections resolve only while `open`.
 */
export function usePageActivity(session, open) {
  const [, update] = useState(0);
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
  const { agents, peers } = pageActivity(session, session.now(), { resolveSelections: open });
  return {
    agents,
    peers,
    count: agents.length + peers.length,
    passages: open ? progressPassages(session) : [],
  };
}

/** The activity heading and list, shared by the header popover and the phone menu's panel. */
export function ActivityList({ agents, peers, passages, onReveal }) {
  return (
    <>
      <strong className="activity-heading">Page activity</strong>
      <ul>
        {agents.map((agent) => (
          <li key={`agent:${agent.key}`}>
            <Identity identity={agent} />
            {agent.presence && <p className="muted">{PRESENCE_STATE[agent.presence.state]}</p>}
            {agent.progress.map((item) => (
              <div key={item.progress_id}>
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
              </div>
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
    </>
  );
}

export function PageActivity({ session, disclosure, onReveal }) {
  const [open, setOpen] = useState(false);
  const activity = usePageActivity(session, open);
  const { count } = activity;
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
        aria-label={`Page activity, ${activitySessions(count)}`}
        title="Page activity"
      >
        <UsersRound size={18} aria-hidden="true" />
        <span className="activity-count">{count}</span>
      </summary>
      <div className="activity-popover">
        <ActivityList {...activity} onReveal={onReveal} />
      </div>
    </details>
  );
}
