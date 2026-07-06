import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { BehaviorSubject } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { cloudAccessRequestStore } from "../cloud-access-request-store";
import { CloudAuthStore } from "../cloud-auth-store";
import { CloudAuthStoreProvider } from "../cloud-auth-context";
import { cloudCatalogStore } from "../cloud-catalog-store";
import { CloudStoresProvider, type CloudStores } from "../cloud-stores-context";
import { CloudUserStore } from "../cloud-user-store";
import { cloudWorkstationsStore } from "../cloud-workstations-store";
import type { CloudPrototypeAuthState } from "../collaborator-auth";
import type { CloudViewerPresenceState } from "../presence";
import { useCloudUserStoreController, useResolvedActor } from "../use-cloud-user-store";

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

function wrapperFor(
  user: CloudUserStore,
  authStore?: CloudAuthStore,
): ({ children }: { children: ReactNode }) => ReactNode {
  const stores: CloudStores = {
    accessRequest: cloudAccessRequestStore,
    catalog: cloudCatalogStore,
    user,
    workstations: cloudWorkstationsStore,
  };
  return ({ children }) => {
    const tree = createElement(CloudStoresProvider, { stores, children });
    return authStore
      ? createElement(CloudAuthStoreProvider, { store: authStore, children: tree })
      : tree;
  };
}

describe("useResolvedActor", () => {
  it("activates the consumed user store with auth and endpoint inputs", async () => {
    const user = new CloudUserStore();
    const authStore = new CloudAuthStore({ readAuthState: () => STABLE_AUTH });
    const inputs: unknown[] = [];
    const activate = vi.spyOn(user, "activate").mockImplementation((inputs$) => {
      const subscription = inputs$.subscribe((value) => inputs.push(value));
      return () => subscription.unsubscribe();
    });

    renderHook(() => useCloudUserStoreController("/author-profiles"), {
      wrapper: wrapperFor(user, authStore),
    });

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(inputs).toEqual([
      {
        auth: STABLE_AUTH,
        authorProfilesEndpoint: "/author-profiles",
      },
    ]);
  });

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

  it("requests profile backfill and reflects a store upgrade", async () => {
    const user = new CloudUserStore();
    const fetchProfiles = vi.fn(async () =>
      Response.json({
        profiles: [
          {
            principal: actor(1),
            label: "Profile Peer",
            image_url: "/avatars/profile-peer.png",
            resolved: true,
          },
        ],
      }),
    );
    const inputs$ = new BehaviorSubject({
      auth: STABLE_AUTH,
      authorProfilesEndpoint: "/author-profiles",
    });
    const dispose = user.activate(inputs$, { fetchProfiles });
    const { result } = renderHook(() => useResolvedActor(actor(1)), {
      wrapper: wrapperFor(user),
    });

    try {
      act(() => {
        user.seedFromPresence(
          presenceState({
            peers: [
              {
                id: "peer-1",
                participantKey: actor(1),
                label: "Presence Peer",
                connectionScope: null,
                kind: "peer",
                status: "active",
              },
            ],
          }),
          STABLE_AUTH,
        );
      });
      expect(result.current.displayName).toBe("Presence Peer");

      act(() => {
        user.requestResolve([actor(1)]);
      });

      await waitFor(() => expect(result.current.displayName).toBe("Profile Peer"));
      expect(result.current.imageUrl).toBe("/avatars/profile-peer.png");
      expect(fetchProfiles).toHaveBeenCalledWith(
        "/author-profiles?actor_label=user%3Aanaconda%3Aactor-1",
        expect.any(AbortSignal),
      );
    } finally {
      dispose();
    }
  });
});
