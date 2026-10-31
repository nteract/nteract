// The clock outage timing reads: the session check's run of unreachable
// answers and a Page's run of failed receipts. performance.now() counts from
// page load and never moves with the wall clock, so setting the system time
// back or forward neither hides an outage nor reports one early. Tests inject
// their own clock instead.
export const monotonicNow = () => globalThis.performance.now();
