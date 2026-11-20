import React, { useEffect, useRef } from "react";
import { NO_ACCESS_HEADING, noAccessMessage } from "./no-access.mjs";

/** Shown in place of a Page or Project this account can't read
 * (no-access.mjs). Its one action goes to the library. Focus moves to the
 * heading when it mounts, so a screen reader announces it once; mount one
 * per refusal. */
export function NoAccess({ kind, accountName, onHome }) {
  const heading = useRef(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <main className="welcome no-access" data-kind={kind}>
      <div className="access-notice retired-notice">
        <h1 ref={heading} tabIndex={-1}>
          {NO_ACCESS_HEADING}
        </h1>
        <p>{noAccessMessage(kind, accountName)}</p>
        <a className="primary" href="/" onClick={onHome}>
          Go to your Pages
        </a>
      </div>
    </main>
  );
}
