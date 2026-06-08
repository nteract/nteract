/**
 * Kernel status types and UI labels.
 *
 * Core types re-exported from runtimed; UI-specific labels live here.
 */

export {
  getLifecycleLabel,
  getStatusKeyLabel,
  isKernelStatus,
  KERNEL_STATUS,
  RUNTIME_STATUS,
  RUNTIME_STATUS_LABELS,
  runtimeStatusKey,
  statusKeyToLegacyStatus,
  type KernelActivity,
  type KernelStatus,
  type RuntimeLifecycle,
  type RuntimeStatusKey,
} from "runtimed";

import {
  KERNEL_STATUS,
  RUNTIME_STATUS,
  type KernelStatus,
  type RuntimeStatusKey,
} from "runtimed";

export function getTrustApprovalHandoffDisplayStatus({
  pending,
  kernelStatus,
  statusKey,
}: {
  pending: boolean;
  kernelStatus: KernelStatus;
  statusKey: RuntimeStatusKey;
}): { kernelStatus: KernelStatus; statusKey: RuntimeStatusKey } {
  if (
    pending &&
    (statusKey === RUNTIME_STATUS.AWAITING_TRUST || statusKey === RUNTIME_STATUS.NOT_STARTED)
  ) {
    return {
      kernelStatus: KERNEL_STATUS.STARTING,
      statusKey: RUNTIME_STATUS.RESOLVING,
    };
  }

  return { kernelStatus, statusKey };
}
