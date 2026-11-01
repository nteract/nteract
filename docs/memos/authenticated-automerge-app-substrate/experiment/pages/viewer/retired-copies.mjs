/** How many copies a retired Page's download holds: each recovery record,
 * plus this tab's own export while the archive doesn't hold it (still
 * writing, or the write failed). PageSession.exportRecoveries builds them. */
export function retiredCopies(session, recoveries) {
  return recoveries.length + (session.closedRecovery && !session.recoveryArchived ? 1 : 0);
}
