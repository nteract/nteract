// Queue waiting owns no downloaded artifacts or interpreter operation budget.
export const PACKAGE_ACQUISITION_MS = 120_000;
export const PACKAGE_INSTALL_MS = 30_000;
export const PACKAGE_OPERATION_MS = PACKAGE_ACQUISITION_MS + PACKAGE_INSTALL_MS;
export const PACKAGE_MAX_WAITING = 4;
const SETTLE_ALLOWANCE_MS = 30_000;
// Four preceding turns, including allowance for confirmed planner cleanup.
export const PACKAGE_QUEUE_WAIT_MS =
  PACKAGE_MAX_WAITING * (PACKAGE_OPERATION_MS + SETTLE_ALLOWANCE_MS);
// Also allow an already-running cell to finish and the final room checkpoint.
export const PACKAGE_REQUEST_TIMEOUT_MS =
  PACKAGE_QUEUE_WAIT_MS + PACKAGE_OPERATION_MS + 2 * SETTLE_ALLOWANCE_MS;
