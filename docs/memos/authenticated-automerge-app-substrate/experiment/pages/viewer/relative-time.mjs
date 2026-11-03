// Ages for listing rows: a compact label on screen ("now", "5m", "3h", "2d",
// "1w", "2mo", "1y") and a spoken form for screen readers ("Last active 2
// days ago, Nov 1, 2026, 6:00 PM"). Pure: callers pass the clock, locale and time
// zone, so tests pin every boundary.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365.25 * DAY;
const MONTH = YEAR / 12;

/** What a missing or unreadable time shows. */
export const NO_TIME = "—";
/** What a screen reader hears for a missing or unreadable time. */
export const NO_TIME_SPOKEN = "Last active unknown";

const SUFFIX = { minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };

/** `value` (an ISO string, epoch milliseconds or a Date) as a Date, or null
 * when it doesn't name a real instant. */
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The age of `date` at `at` in its largest whole unit, or null under a
 * minute. A date after `at` (clock skew between this browser and the
 * server) counts as under a minute. */
function age(date, at) {
  const elapsed = at.getTime() - date.getTime();
  if (elapsed < MINUTE) return null;
  if (elapsed < HOUR) return { value: Math.floor(elapsed / MINUTE), unit: "minute" };
  if (elapsed < DAY) return { value: Math.floor(elapsed / HOUR), unit: "hour" };
  if (elapsed < WEEK) return { value: Math.floor(elapsed / DAY), unit: "day" };
  if (elapsed < 30 * DAY) return { value: Math.floor(elapsed / WEEK), unit: "week" };
  if (elapsed < 365 * DAY)
    return { value: Math.max(1, Math.floor(elapsed / MONTH)), unit: "month" };
  return { value: Math.max(1, Math.floor(elapsed / YEAR)), unit: "year" };
}

/** How long before `now` the instant `value` was, as a compact label. */
export function compactAge(value, now = Date.now()) {
  const date = toDate(value);
  const at = toDate(now);
  if (!date || !at) return NO_TIME;
  const parts = age(date, at);
  return parts ? `${parts.value}${SUFFIX[parts.unit]}` : "now";
}

/** Everything a Last activity cell needs: the compact label, the ISO dateTime,
 * and the spoken form. `locale` and `timeZone` default to the browser's. */
export function timeCell(value, now = Date.now(), { locale, timeZone } = {}) {
  const date = toDate(value);
  const at = toDate(now);
  if (!date || !at) return { label: NO_TIME, dateTime: null, spoken: NO_TIME_SPOKEN };
  const parts = age(date, at);
  const relative = parts
    ? new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-parts.value, parts.unit)
    : new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  const absolute = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
  return {
    label: parts ? `${parts.value}${SUFFIX[parts.unit]}` : "now",
    dateTime: date.toISOString(),
    spoken: `Last active ${relative}, ${absolute}`,
  };
}
