import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { cloudAccessRequestStore } from "../cloud-access-request-store";
import { cloudCatalogStore } from "../cloud-catalog-store";
import { CloudStoresProvider, type CloudStores } from "../cloud-stores-context";
import { CloudUserStore } from "../cloud-user-store";
import { cloudWorkstationsStore } from "../cloud-workstations-store";
import type { CloudPrototypeAuthState } from "../collaborator-auth";
import type { CloudViewerPresenceState } from "../presence";
import { useResolvedActor } from "../use-cloud-user-store";

const STABLE_AUTH: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-token",
  user: "Owner User",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

function actor(index: number): string {
  return `user:anaconda:actor-${index}`;
}

function presenceState(
  overrides: Partial<CloudViewerPresenceState> = {},
): CloudViewerPresenceState {
  return {
    connection: "connected",
    ownPeerId: null,
    actorLabel: null,
    ownPeerLabel: null,
    peers: [],
    roomPeerCount: 1,
    runtimePeerCount: 0,
    ...overrides,
  };
}

function wrapperFor(user: CloudUserStore): ({ children }: { children: ReactNode }) => ReactNode {
  const stores: CloudStores = {
    accessRequest: cloudAccessRequestStore,
    catalog: cloudCatalogStore,
    user,
    workstations: cloudWorkstationsStore,
  };
  return ({ children }) => createElement(CloudStoresProvider, { stores, children });
}

describe("useResolvedActor", () => {
  it("subscribes only to the rendered principal", () => {
    const user = new CloudUserStore();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useResolvedActor(actor(1));
      },
      { wrapper: wrapperFor(user) },
    );

    act(() => {
      user.seedFromPresence(
        presenceState({
          peers: [
            {
              id: "peer-2",
              participantKey: actor(2),
              label: "Other Peer",
              connectionScope: null,
              kind: "peer",
              status: "active",
            },
          ],
        }),
        STABLE_AUTH,
      );
    });
    expect(renders).toBe(1);

    act(() => {
      user.seedFromPresence(
        presenceState({
          peers: [
            {
              id: "peer-1",
              participantKey: actor(1),
              label: "Rendered Peer",
              connectionScope: null,
              kind: "peer",
              status: "active",
            },
          ],
        }),
        STABLE_AUTH,
      );
    });

    expect(renders).toBe(2);
    expect(result.current.displayName).toBe("Rendered Peer");
  });
});
