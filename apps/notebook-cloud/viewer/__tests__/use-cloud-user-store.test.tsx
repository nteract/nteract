import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, useMemo, type ReactNode } from "react";
import { BehaviorSubject } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { NotebookToolbarIdentity } from "@/components/notebook";
import { cloudAccessRequestStore } from "../cloud-access-request-store";
import { CloudAuthStore } from "../cloud-auth-store";
import { CloudAuthStoreProvider } from "../cloud-auth-context";
import { cloudCatalogStore } from "../cloud-catalog-store";
import { CloudStoresProvider, type CloudStores } from "../cloud-stores-context";
import { CloudUserStore } from "../cloud-user-store";
import { cloudWorkstationsStore } from "../cloud-workstations-store";
import type { CloudPrototypeAuthState } from "../collaborator-auth";
import type { CloudViewerPresenceState } from "../presence";
import { useCloudShellCapabilities } from "../use-cloud-shell-capabilities";
import {
  useCloudUserStoreController,
  useResolvedActor,
  useResolvedActorProfile,
} from "../use-cloud-user-store";

const STABLE_AUTH: CloudPrototypeAuthState = {
  mode: "dev",
  token: "dev-token",
  user: "Owner User",
  oidcClaims: null,
  requestedScope: "owner",
  problem: null,
};

const OIDC_AUTH: CloudPrototypeAuthState = {
  mode: "oidc",
  token: "oidc-token",
  user: "claims@example.test",
  oidcClaims: {
    sub: "actor-1",
    email: "claims@example.test",
    email_verified: true,
    name: "Claims Alice",
    picture: "https://profiles.example/claims.png",
  },
  requestedScope: "owner",
  problem: null,
};

function actor(index: number): string {
  return `user:anaconda:actor-${index}`;
}

const SELF_ACTOR_LABEL = `${actor(1)}/browser:tab`;

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

function ToolbarSelfIdentityProbe() {
  const selfProfile = useResolvedActorProfile(SELF_ACTOR_LABEL);
  const selfDisplay = useMemo(() => {
    const label = selfProfile?.displayName?.trim() || null;
    const imageUrl = selfProfile?.avatarUrl?.trim() || null;
    return label || imageUrl ? { label, imageUrl } : undefined;
  }, [selfProfile?.avatarUrl, selfProfile?.displayName]);
  const { shellCapabilities } = useCloudShellCapabilities({
    authState: OIDC_AUTH,
    selfDisplay,
    connectionScope: "owner",
    connectionActorLabel: SELF_ACTOR_LABEL,
    connectionPeerId: "peer-1",
    connectionPeerLabel: null,
    connectionError: null,
    status: { kind: "ready", message: "Ready" },
    selectedMode: "edit",
    hasAppSession: true,
    codeCellCount: 1,
    runtimePeerAvailable: false,
    runtimePeerCount: 0,
    kernelStatusLabel: null,
    workstationAttachment: null,
    hostCapabilities: { canManageSharing: false },
  });

  return createElement(NotebookToolbarIdentity, {
    capabilities: shellCapabilities,
    variant: "inline",
  });
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

describe("self identity convergence", () => {
  it("updates the toolbar identity label when the user store upgrades the self profile", async () => {
    const user = new CloudUserStore();
    const fetchProfiles = vi.fn(async () =>
      Response.json({
        profiles: [
          {
            principal: actor(1),
            label: "D1 Alice",
            image_url: "/avatars/d1-alice.png",
            resolved: true,
          },
        ],
      }),
    );
    const inputs$ = new BehaviorSubject({
      auth: OIDC_AUTH,
      authorProfilesEndpoint: "/author-profiles",
    });
    const dispose = user.activate(inputs$, { fetchProfiles });

    try {
      render(createElement(ToolbarSelfIdentityProbe), {
        wrapper: wrapperFor(user),
      });

      expect(screen.getByText("Claims Alice")).toBeTruthy();

      act(() => {
        user.requestResolve([SELF_ACTOR_LABEL]);
      });

      await waitFor(() => expect(screen.getByText("D1 Alice")).toBeTruthy());
      expect(screen.queryByText("Claims Alice")).toBeNull();
      expect(fetchProfiles).toHaveBeenCalledWith(
        "/author-profiles?actor_label=user%3Aanaconda%3Aactor-1%2Fbrowser%3Atab",
        expect.any(AbortSignal),
      );
    } finally {
      dispose();
    }
  });
});
