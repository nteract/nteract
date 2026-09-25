// Queue waiting owns no downloaded artifacts or interpreter operation budget.
export const PACKAGE_OPERATION_MS = 120_000;
export const PACKAGE_QUEUE_WAIT_MS = 600_000;
// Cover a retained FIFO turn, active installation and final room checkpoint.
export const PACKAGE_REQUEST_TIMEOUT_MS = PACKAGE_QUEUE_WAIT_MS + PACKAGE_OPERATION_MS + 30_000;
