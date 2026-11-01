/** Share of the Page limit at which Home starts showing usage. */
export const QUOTA_NOTICE_SHARE = 0.9;

const pages = (value) => `${value.toLocaleString("en-US")} ${value === 1 ? "Page" : "Pages"}`;

/**
 * Home's usage note for list_pages' `quota` (`{ limit, count }`, the
 * caller's own active Pages), or null below 90% of the limit. A missing or
 * malformed quota, as from an earlier build, shows nothing.
 */
export function quotaNotice(quota) {
  const limit = quota?.limit;
  const count = quota?.count;
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(count) || limit < 0 || count < 0)
    return null;
  if (limit === 0) return "Creating Pages is turned off for this account.";
  if (count < limit * QUOTA_NOTICE_SHARE) return null;
  if (count >= limit)
    return `You're using ${pages(count)} of ${pages(limit)}, the limit for this alpha release. Move Pages to Trash to make room for new ones.`;
  return `You're using ${pages(count)} of ${pages(limit)} in this alpha release.`;
}
