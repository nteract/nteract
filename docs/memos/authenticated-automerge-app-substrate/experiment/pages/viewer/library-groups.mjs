// Group sections for the Pages library: a presentation over the rows it has
// loaded (pageRow in listing.mjs), never a request of its own. Load more
// appends rows, and they join their groups. Groups keep the order their first
// row appears in, so the server's sort decides both the group order and the
// order within each group. Pure: callers pass the clock, locale and time zone.
import { toDate } from "./relative-time.mjs";

/** Rows only this browser holds (deviceRows) group on their own, first. */
export const DEVICE_GROUP = Object.freeze({ key: "device", label: "On this device" });
/** Owned rows outside any Project. */
export const ITEMS_GROUP = Object.freeze({ key: "items", label: "Your items" });
/** Rows shared with the account. They never reveal a Project. */
export const SHARED_GROUP = Object.freeze({ key: "shared", label: "Shared with you" });
/** Rows without a readable time. */
export const UNDATED_GROUP = Object.freeze({ key: "undated", label: "No date" });

const DAY = 24 * 60 * 60 * 1000;

/** The calendar day `date` falls on in `timeZone`, as a day number and its
 * year and month (1-12). */
function calendarDay(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    day: Date.UTC(parts.year, parts.month - 1, parts.day) / DAY,
    year: parts.year,
    month: parts.month,
  };
}

/**
 * The date group for `value` seen at `now`, by calendar day in `timeZone`:
 * Today, Yesterday, Previous 7 days, Previous 30 days, then each month of
 * the last year ("October 2026"), then each year ("2025"). A time after
 * `now` (clock skew) counts as today.
 */
export function dateGroup(value, now = Date.now(), { locale, timeZone } = {}) {
  const date = toDate(value);
  const at = toDate(now);
  if (!date || !at) return UNDATED_GROUP;
  const then = calendarDay(date, timeZone);
  const today = calendarDay(at, timeZone);
  const days = today.day - then.day;
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days <= 7) return { key: "week", label: "Previous 7 days" };
  if (days <= 30) return { key: "month", label: "Previous 30 days" };
  const months = today.year * 12 + today.month - (then.year * 12 + then.month);
  if (months < 12) {
    // Noon UTC on the 15th names the month in any time zone.
    const label = new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(then.year, then.month - 1, 15, 12)));
    return { key: `m:${then.year}-${String(then.month).padStart(2, "0")}`, label };
  }
  return { key: `y:${then.year}`, label: String(then.year) };
}

/** The Project group for a row: its Project, Your items, Shared with you,
 * or On this device. A Project group carries its id and link. */
export function projectGroup(row) {
  if (row.local) return DEVICE_GROUP;
  if (row.shared) return SHARED_GROUP;
  if (row.project)
    return {
      key: `project:${row.project.id}`,
      label: row.project.title,
      projectId: row.project.id,
      href: row.project.href,
    };
  return ITEMS_GROUP;
}

/**
 * `rows` in sections for `group` ("project", "date" or null). Each section is
 * `{ key, label, rows }`, plus `projectId` and `href` for a Project. With no
 * grouping there is one section whose label is null. Rows from this device
 * form their own section in every grouping; the library lists them first, so
 * that section leads.
 */
export function groupRows(rows, group, { now = Date.now(), locale, timeZone } = {}) {
  if (group !== "project" && group !== "date")
    return rows.length ? [{ key: "all", label: null, rows }] : [];
  const sections = new Map();
  for (const row of rows) {
    const head =
      group === "project"
        ? projectGroup(row)
        : row.local
          ? DEVICE_GROUP
          : dateGroup(row.updatedAt, now, { locale, timeZone });
    let section = sections.get(head.key);
    if (!section) {
      section = { ...head, rows: [] };
      sections.set(head.key, section);
    }
    section.rows.push(row);
  }
  return [...sections.values()];
}
