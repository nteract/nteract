// Presentation of the Page's named sources, derived from page-source-store.
// The host's last-set timestamp means "added" at revision 1 and "refreshed"
// thereafter, even when a refresh points to the same asset. It is neither
// the asset's upload time nor the date of the rows in that asset.
import { asyncScheduler, map, timer } from "rxjs";
import { toDate } from "./relative-time.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A cold clock: a visible line subscribes; unmounting stops its timer. */
export const sourceLineClock = ({ now = Date.now, scheduler = asyncScheduler } = {}) =>
  timer(0, MINUTE, scheduler).pipe(map(() => now()));

/** Relative for seven days, then a local calendar date. Exact time is
 * always available for hover and assistive technology. */
export function sourceTime(value, now, { locale, timeZone } = {}) {
  const date = toDate(value);
  const at = toDate(now);
  if (!date || !at)
    return { label: "at an unknown time", dateTime: null, exact: "Time unavailable" };
  const elapsed = Math.max(0, at.getTime() - date.getTime());
  // These are elapsed units, not calendar-day distances: 47 hours can
  // span two midnights, so "1 day ago" is accurate where "yesterday" isn't.
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone });
  const label =
    elapsed < MINUTE
      ? "just now"
      : elapsed < HOUR
        ? relative.format(-Math.floor(elapsed / MINUTE), "minute")
        : elapsed < DAY
          ? relative.format(-Math.floor(elapsed / HOUR), "hour")
          : elapsed < 7 * DAY
            ? relative.format(-Math.floor(elapsed / DAY), "day")
            : new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                timeZone,
                ...(year.format(date) !== year.format(at) ? { year: "numeric" } : {}),
              }).format(date);
  return {
    label,
    dateTime: date.toISOString(),
    exact: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone,
    }).format(date),
  };
}

/** The bounded line model. Zero sources produces no placeholder. Named
 * entries keep alphabetical order on refresh; dates summarize all sources,
 * including unused ones and those that have only been added once. */
export function sourceLine(sources, now, options = {}) {
  const ordered = Object.values(sources).sort(
    (a, b) =>
      a.name.localeCompare(b.name, options.locale) || a.source_id.localeCompare(b.source_id),
  );
  if (!ordered.length) return null;
  const describe = (source) => ({
    id: source.source_id,
    name: source.name,
    action: source.revision === "1" ? "added" : "refreshed",
    time: sourceTime(source.set_at, now, options),
  });
  const byTime = [...ordered].sort((a, b) => Date.parse(a.set_at) - Date.parse(b.set_at));
  return {
    count: ordered.length,
    entries: ordered.length <= 3 ? ordered.map(describe) : [],
    newest: describe(byTime.at(-1)),
    oldest: describe(byTime[0]),
  };
}
