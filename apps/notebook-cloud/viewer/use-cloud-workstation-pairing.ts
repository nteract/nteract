import { useCallback, useEffect, useMemo, useState } from "react";
import type { NotebookRegisteredWorkstation } from "runtimed";

import type { CloudPrototypeAuthState } from "./collaborator-auth";
import {
  CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS,
  cloudWorkstationConnectCommand,
  cloudWorkstationPairingCommands,
  fetchCloudWorkstationPairingStatus,
  mintCloudWorkstationPairingCode,
  type CloudWorkstationPairingCommand,
  type CloudWorkstationPairingStatus,
} from "./workstations-client";

export interface CloudWorkstationPairing {
  id: string;
  code: string;
  connectCommand: string;
  commands: readonly CloudWorkstationPairingCommand[];
  expiresAt: string;
  status: CloudWorkstationPairingStatus;
  workstationId: string | null;
  workstationName: string | null;
  error: string | null;
}

export interface UseCloudWorkstationPairingInput {
  workstationsEndpoint: string | undefined;
  authState: CloudPrototypeAuthState;
  workstations: readonly NotebookRegisteredWorkstation[];
  onRegistered?: () => void | Promise<void>;
}

/**
 * Pairing-code lifecycle shared by the notebook rail panel and the
 * workstations management page: mint a code, poll redemption, flip to
 * expired client-side, and resolve the registered workstation's name.
 */
export function useCloudWorkstationPairing({
  workstationsEndpoint,
  authState,
  workstations,
  onRegistered,
}: UseCloudWorkstationPairingInput): {
  pairing: CloudWorkstationPairing | null;
  startPairing: () => Promise<void>;
  cancelPairing: () => void;
} {
  const [pairing, setPairing] = useState<CloudWorkstationPairing | null>(null);

  const startPairing = useCallback(async () => {
    if (!workstationsEndpoint) {
      return;
    }
    try {
      const minted = await mintCloudWorkstationPairingCode(workstationsEndpoint, authState);
      setPairing({
        id: minted.id,
        code: minted.code,
        connectCommand: cloudWorkstationConnectCommand(window.location.origin, minted.code),
        commands: cloudWorkstationPairingCommands(window.location.origin, minted.code),
        expiresAt: minted.expiresAt,
        status: "pending",
        workstationId: null,
        workstationName: null,
        error: null,
      });
    } catch (error) {
      setPairing({
        id: "",
        code: "",
        connectCommand: "",
        commands: [],
        expiresAt: new Date(0).toISOString(),
        status: "expired",
        workstationId: null,
        workstationName: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [authState, workstationsEndpoint]);

  const cancelPairing = useCallback(() => {
    setPairing(null);
  }, []);

  const pairingPollActive =
    pairing !== null &&
    pairing.id !== "" &&
    (pairing.status === "pending" || pairing.status === "redeemed");

  useEffect(() => {
    if (!pairingPollActive || !workstationsEndpoint) {
      return;
    }
    const endpoint = workstationsEndpoint;
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const poll = () => {
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        activeController = controller;
        const pairingId = pairing.id;
        void fetchCloudWorkstationPairingStatus(endpoint, authState, pairingId, controller.signal)
          .then((next) => {
            if (disposed || controller.signal.aborted) return;
            setPairing((previous) =>
              previous && previous.id === pairingId
                ? {
                    ...previous,
                    status: next.status,
                    workstationId: next.workstationId,
                    error: null,
                  }
                : previous,
            );
            if (next.status === "registered") {
              void onRegistered?.();
            }
          })
          .catch(() => {
            // Transient poll failures are invisible; the next tick retries.
          })
          .finally(() => {
            if (activeController === controller) {
              activeController = null;
            }
            if (!disposed) {
              poll();
            }
          });
      }, CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activeController?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, onRegistered, workstationsEndpoint, pairing?.id, pairingPollActive]);

  // The expiry transition is client-driven so the card flips to "expired"
  // even if no poll lands exactly at the boundary.
  useEffect(() => {
    if (!pairing || pairing.status !== "pending") {
      return;
    }
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) {
      return;
    }
    if (remaining <= 0) {
      setPairing((previous) =>
        previous && previous.id === pairing.id ? { ...previous, status: "expired" } : previous,
      );
      return;
    }
    const timer = window.setTimeout(() => {
      setPairing((previous) =>
        previous && previous.id === pairing.id && previous.status === "pending"
          ? { ...previous, status: "expired" }
          : previous,
      );
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const pairingWithName = useMemo<CloudWorkstationPairing | null>(() => {
    if (!pairing) {
      return null;
    }
    if (!pairing.workstationId) {
      return pairing;
    }
    const registered = workstations.find((workstation) => workstation.id === pairing.workstationId);
    return registered ? { ...pairing, workstationName: registered.displayName } : pairing;
  }, [pairing, workstations]);

  return { pairing: pairingWithName, startPairing, cancelPairing };
}
