import { ServerOff } from "lucide-react";
import type { NotebookWorkstationLaunchReadinessState } from "./capabilities";
import { NotebookNotice, NotebookNoticeAction } from "./NotebookNotice";

/**
 * A cloud notebook opens with nothing attached and, before this notice, said so
 * only inside the collapsed workstations rail panel.
 *
 * The gate is launch readiness rather than `canExecute` so a notebook that
 * merely *cannot* run (read-only viewer, signed out) stays quiet — that is not
 * a compute problem the reader can fix by pairing a machine. `needs_selection`,
 * `needs_attachment`, and `workstation_unavailable` stay quiet too: each
 * already raises its own toolbar action, and none is fixed by pairing.
 */
export function shouldShowWorkstationComputeNotice({
  canRegisterWorkstation,
  launchReadinessState,
}: {
  canRegisterWorkstation: boolean;
  launchReadinessState: NotebookWorkstationLaunchReadinessState;
}): boolean {
  return canRegisterWorkstation && launchReadinessState === "needs_registration";
}

export function WorkstationComputeNotice({ onConnect }: { onConnect: () => void }) {
  return (
    <NotebookNotice
      tone="info"
      icon={<ServerOff className="size-4" />}
      title="No compute connected."
      data-testid="workstation-compute-notice"
      actions={
        <NotebookNoticeAction onClick={onConnect} data-testid="workstation-compute-notice-action">
          Connect compute
        </NotebookNoticeAction>
      }
    >
      This notebook has no machine to run on. Connect one you own to run cells here.
    </NotebookNotice>
  );
}
