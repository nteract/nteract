// The clock the viewer's elapsed-time rules read: session-check and receipt
// outages, reconnect stability, presence and agent-progress lifetimes, and
// recheck throttles. performance.now() counts from page load and never moves
// with the wall clock, so setting the system time back or forward can't
// stretch or cut short any of them. Tests inject their own clock instead.
// Date.now() stays for wall-clock values: timestamps written to storage or
// the wire, and server times such as expires_at.
export const monotonicNow = () => globalThis.performance.now();
