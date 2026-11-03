// Compact ages for listing rows: "now", "5m", "3h", "2d", "1w", "2mo", "1y".
// Pure: callers pass the clock, so tests pin every boundary.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365.25 * DAY;
const MONTH = YEAR / 12;

/** What a missing or unreadable time shows. */
export const NO_TIME = "—";

/** `value` (an ISO string, epoch milliseconds or a Date) as a Date, or null
 * when it doesn't name a real instant. */
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** How long before `now` the instant `value` was, in the largest whole unit.
 * Under a minute, and any time after `now` (clock skew between this browser
 * and the server), is "now". */
export function compactAge(value, now = Date.now()) {
  const date = toDate(value);
  const at = toDate(now);
  if (!date || !at) return NO_TIME;
  const elapsed = at.getTime() - date.getTime();
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / WEEK)}w`;
  if (elapsed < 365 * DAY) return `${Math.max(1, Math.floor(elapsed / MONTH))}mo`;
  return `${Math.max(1, Math.floor(elapsed / YEAR))}y`;
}

/** Everything a `<time>` cell needs: the compact label, the machine-readable
 * dateTime, and the full local date and time for its tooltip. dateTime and
 * title are null when the value isn't a real instant. */
export function timeCell(value, now = Date.now(), locale = undefined) {
  const date = toDate(value);
  if (!date) return { label: NO_TIME, dateTime: null, title: null };
  return {
    label: compactAge(date, now),
    dateTime: date.toISOString(),
    title: date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
  };
}
