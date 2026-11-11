// The pieces every comments layout shares: avatars, the author line, the
// anchor chip, a clamped message body and runs of replies. Display only.
import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, ListChecks, Table, Text, Unlink } from "lucide-react";
import { CommentContent } from "./CommentRichText.jsx";
import { AgentMark, agentMarkFor, markHasTile } from "./AgentMark.jsx";
import {
  attribution,
  fullTime,
  isLongBody,
  messageRuns,
  modelLabel,
  modelNote,
  relativeTime,
} from "./comment-thread-display.mjs";

/** The current time, refreshed each minute so relative times stay honest. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Avatar({ author, size = 24 }) {
  const who = attribution(author);
  const mark = who.agent ? agentMarkFor(author?.driver) : null;
  if (mark)
    return (
      <span
        className={
          "comment-avatar comment-avatar-agent comment-avatar-mark" +
          (markHasTile(mark) ? " comment-avatar-own-tile" : "")
        }
        style={{ "--avatar-size": `${size}px` }}
        title={who.label}
        aria-hidden="true"
      >
        <AgentMark mark={mark} size={Math.round(size * (markHasTile(mark) ? 1 : 0.62))} />
        <span className="comment-avatar-badge">{who.personInitials.slice(0, 1)}</span>
      </span>
    );
  return (
    <span
      className={"comment-avatar" + (who.agent ? " comment-avatar-agent" : "")}
      style={{
        "--avatar-size": `${size}px`,
        "--avatar-color": who.color,
        "--avatar-foreground": who.foreground,
      }}
      title={who.label}
      aria-hidden="true"
    >
      {who.initials}
      {who.agent && <span className="comment-avatar-badge">{who.personInitials.slice(0, 1)}</span>}
    </span>
  );
}

/** Name, "via Kilo for Kyle" when an agent wrote it, and when. The full
 * attribution, the model the client reported and the exact time are the
 * tooltip. Agent and model are client assertions, drawn as text. */
export function MessageAuthor({ message, now }) {
  const who = attribution(message.author);
  const time = message.createdAt ? fullTime(message.createdAt) : "";
  const title = [time ? `${who.label} · ${time}` : who.label, modelNote(who)]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="message-author" title={title}>
      <strong>{who.name}</strong>
      {who.via && <span className="comment-delegate">via {who.via}</span>}
      {who.agent && (
        <span className="comment-delegate" aria-label={`on behalf of ${who.person}`}>
          for {who.onBehalfOf}
        </span>
      )}
      {modelLabel(who) && <span className="muted comment-model">{modelLabel(who)}</span>}
      {message.createdAt && (
        <time className="muted comment-time" dateTime={message.createdAt}>
          {relativeTime(message.createdAt, now)}
        </time>
      )}
    </div>
  );
}

const BLOCK_ICONS = { Table, Checklist: ListChecks };

/** Where the thread points. A button when it can scroll the Page there. */
export function AnchorChip({ anchor, onReveal, className = "" }) {
  if (anchor.kind === "selection")
    return (
      <button
        type="button"
        className={"quote anchor-chip anchor-selection " + className}
        onClick={onReveal}
        title="Show passage"
      >
        <span className="anchor-chip-text">{anchor.text}</span>
      </button>
    );
  if (anchor.kind === "block") {
    const Icon = BLOCK_ICONS[anchor.label.split(" · ")[0]] ?? Text;
    return (
      <button
        type="button"
        className={"quote anchor-chip anchor-block " + className}
        onClick={onReveal}
        title="Show block"
      >
        <Icon size={13} aria-hidden="true" />
        <span className="anchor-chip-text">{anchor.label}</span>
      </button>
    );
  }
  return (
    <div className={"anchor-chip anchor-detached " + className}>
      <Unlink size={13} aria-hidden="true" />
      <span className="thread-detached">Passage removed</span>
      {anchor.blockSurvives && (
        <button type="button" className="anchor-chip-action" onClick={onReveal}>
          Go to block
        </button>
      )}
    </div>
  );
}

/** A message body that clamps when long, with Show more. */
export function MessageBody({ message, source }) {
  const long = isLongBody(message.body);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <>
      <div id={id} className={"message-body" + (long && !expanded ? " message-body-clamped" : "")}>
        <CommentContent message={message} source={source} />
      </div>
      {long && (
        <button
          type="button"
          className="subtle-button message-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
      )}
    </>
  );
}

/** One message with its avatar column. `continued` hides the avatar and
 * author line for a message in the same author's run. */
export function Message({ message, source, now, continued = false, clamp = true }) {
  const who = attribution(message.author);
  return (
    <div
      className={"message" + (continued ? " message-continued" : "")}
      style={{ "--author-color": who.color }}
    >
      <div className="message-gutter">
        {continued ? (
          message.createdAt && (
            <time className="message-gutter-time" dateTime={message.createdAt}>
              {fullTime(message.createdAt).split(", ").at(-1)}
            </time>
          )
        ) : (
          <Avatar author={message.author} />
        )}
      </div>
      <div className="message-main">
        {!continued && <MessageAuthor message={message} now={now} />}
        {clamp ? (
          <MessageBody message={message} source={source} />
        ) : (
          <div className="message-body">
            <CommentContent message={message} source={source} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Messages grouped into same-author runs, joined by a thin line in each
 * author's color. `sourceOf(message)` gives each message's stored source. */
export function MessageRuns({ messages, sourceOf, now }) {
  const runs = messageRuns(messages);
  return runs.map((run, index) => (
    <div
      className="message-run"
      key={run.messages[0].id}
      data-last={index === runs.length - 1 || undefined}
      style={{ "--author-color": attribution(run.author).color }}
    >
      {run.messages.map((message, position) => (
        <Message
          key={message.id}
          message={message}
          source={sourceOf(message)}
          now={now}
          continued={position > 0}
        />
      ))}
    </div>
  ));
}
