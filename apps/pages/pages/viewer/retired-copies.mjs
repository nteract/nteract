/** How many copies a retired Page's download holds: each recovery record,
 * plus this tab's own copy while the archive doesn't hold it (still writing,
 * the write failed, or the capture failed). PageSession.exportRecoveries
 * builds them. */
export function retiredCopies(session, recoveries) {
  const own = session.closedRecovery ?? session.unarchivedCopy;
  return recoveries.length + (own && !session.recoveryArchived ? 1 : 0);
}
