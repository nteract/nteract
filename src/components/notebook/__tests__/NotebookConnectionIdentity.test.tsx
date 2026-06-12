import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectionStatus } from "runtimed";
import { readOnlyNotebookShellCapabilities } from "../capabilities";
import {
  NotebookConnectionIdentity,
  isRemoteNotebookContext,
  type NotebookConnectionStatusSource,
} from "../NotebookConnectionIdentity";
import type { NotebookShellCapabilities } from "../capabilities";

/** Minimal BehaviorSubject-shaped source (rxjs-free, like the component). */
class FakeStatusSource implements NotebookConnectionStatusSource {
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  constructor(private value: ConnectionStatus) {}

  subscribe(next: (status: ConnectionStatus) => void): { unsubscribe(): void } {
    next(this.value);
    this.listeners.add(next);
    return { unsubscribe: () => this.listeners.delete(next) };
  }

  next(status: ConnectionStatus): void {
    this.value = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Source with a snapshot but NO replay on subscribe — isolates getCurrent. */
class SnapshotOnlyStatusSource implements NotebookConnectionStatusSource {
  constructor(private readonly value: ConnectionStatus) {}

  getCurrent(): ConnectionStatus {
    return this.value;
  }

  subscribe(): { unsubscribe(): void } {
    return { unsubscribe: () => {} };
  }
}

function capabilities(
  overrides: Partial<NotebookShellCapabilities> = {},
): NotebookShellCapabilities {
  return {
    ...readOnlyNotebookShellCapabilities,
    ...overrides,
    access: {
      ...readOnlyNotebookShellCapabilities.access,
      ...overrides.access,
    },
    auth: {
      ...readOnlyNotebookShellCapabilities.auth,
      ...overrides.auth,
    },
    runtime: {
      ...readOnlyNotebookShellCapabilities.runtime,
      ...overrides.runtime,
    },
  };
}

function cloudCapabilities(): NotebookShellCapabilities {
  return capabilities({
    access: {
      level: "editor",
      source: "cloud",
      isPublic: false,
      actorLabel: "user:anaconda:alice/browser:session-1",
      identityLabel: "Alice",
    },
  });
}

function publicViewerCapabilities(): NotebookShellCapabilities {
  return capabilities({
    access: {
      level: "viewer",
      source: "cloud",
      isPublic: true,
      actorLabel: "anonymous:viewer:session-1/browser:tab",
      identityLabel: null,
    },
    auth: {
      canSignIn: true,
      canUseAuthenticatedIdentity: false,
      needsAttention: false,
    },
  });
}

function localCapabilities(): NotebookShellCapabilities {
  return capabilities({
    access: {
      level: "owner",
      source: "local",
      isPublic: false,
      actorLabel: "local:kyle/desktop:abc",
      identityLabel: "Kyle",
    },
    runtime: {
      connected: true,
      canWriteRuntimeState: true,
      source: "local",
      actorLabel: "local:kyle/desktop:abc",
      identityLabel: "Kyle",
      target: { kind: "local_daemon", status: "ready", label: "Local daemon" },
    },
  });
}

function runtimePeerCapabilities(): NotebookShellCapabilities {
  const caps = localCapabilities();
  return capabilities({
    ...caps,
    access: caps.access,
    runtime: {
      ...caps.runtime,
      source: "cloud",
      target: { kind: "runtime_peer", status: "attached", label: "Cloud room" },
    },
  });
}

function renderSlot(
  caps: NotebookShellCapabilities,
  status: ConnectionStatus = "online",
  props: { connectionLabel?: string } = {},
): { container: HTMLElement; source: FakeStatusSource; unmount: () => void } {
  const source = new FakeStatusSource(status);
  const { container, unmount } = render(
    <NotebookConnectionIdentity capabilities={caps} connectionStatus$={source} {...props} />,
  );
  return { container, source, unmount };
}

function slotElement(container: HTMLElement): HTMLElement {
  const slot = container.querySelector<HTMLElement>('[data-slot="notebook-connection-identity"]');
  expect(slot).not.toBeNull();
  return slot!;
}

function dotElement(container: HTMLElement): HTMLElement {
  const dot = container.querySelector<HTMLElement>('[data-slot="avatar-badge"]');
  expect(dot).not.toBeNull();
  return dot!;
}

function liveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[aria-live="polite"]');
  expect(region).not.toBeNull();
  return region!;
}

describe("NotebookConnectionIdentity", () => {
  it("renders nothing for a purely local desktop session", () => {
    // Conditionality is the point (#3290): local identity is noise, not chrome.
    const { container } = renderSlot(localCapabilities());
    expect(container.innerHTML).toBe("");
  });

  it("renders for a local session attached to a runtime peer", () => {
    const { container } = renderSlot(runtimePeerCapabilities());
    expect(slotElement(container)).toBeTruthy();
  });

  it("renders nothing for an anonymous public viewer", () => {
    const { container } = renderSlot(publicViewerCapabilities());
    expect(container.innerHTML).toBe("");
  });

  it.each([
    ["online", "bg-emerald-500", false, "Connected"],
    ["connecting", "bg-amber-500", true, "Connecting"],
    ["reconnecting", "bg-amber-500", true, "Reconnecting"],
    ["offline", "bg-muted", false, "Offline"],
  ] as Array<[ConnectionStatus, string, boolean, string]>)(
    "renders the %s state with the statusTone dot",
    (status, tone, pulses, label) => {
      const { container } = renderSlot(cloudCapabilities(), status);
      const slot = slotElement(container);
      const dot = dotElement(container);

      expect(slot.dataset.state).toBe(status);
      expect(dot.classList.contains(tone)).toBe(true);
      expect(dot.classList.contains("animate-pulse")).toBe(pulses);
      // State expresses as opacity/dot color, never copy: non-online dims.
      expect(slot.classList.contains("opacity-60")).toBe(status !== "online");
      // Detail lives in sr-only copy and the title tooltip only.
      expect(slot.title).toContain(label);
      const srOnly = slot.querySelector(".sr-only");
      expect(srOnly?.textContent).toContain(label);
      expect(srOnly?.textContent).toContain("Alice");
    },
  );

  it("scopes the copy to the measured link via connectionLabel", () => {
    // Desktop measures the daemon link, not daemon<->room health — the
    // copy must say which link it reports so the dot never overclaims.
    const { container } = renderSlot(runtimePeerCapabilities(), "online", {
      connectionLabel: "Daemon connection",
    });
    const slot = slotElement(container);

    expect(slot.title).toContain("Daemon connection: Connected");
    expect(slot.querySelector(".sr-only")?.textContent).toContain("Daemon connection: Connected");
  });

  it("keeps the dot live through a reconnect loop (stale-chrome motivation)", () => {
    // Runtime-state stores are not blanked while the transport reconnects;
    // the dot is what makes the frozen chrome interpretable, so it must
    // track the loop rather than only steady states.
    const { container, source } = renderSlot(cloudCapabilities(), "online");
    expect(slotElement(container).dataset.state).toBe("online");

    act(() => source.next("reconnecting"));
    expect(slotElement(container).dataset.state).toBe("reconnecting");
    expect(dotElement(container).classList.contains("animate-pulse")).toBe(true);

    act(() => source.next("online"));
    expect(slotElement(container).dataset.state).toBe("online");
    expect(dotElement(container).classList.contains("bg-emerald-500")).toBe(true);
  });

  it("seeds first paint from getCurrent without waiting for a subscription replay", () => {
    // SnapshotOnlyStatusSource never replays on subscribe — the rendered
    // state can only come from the synchronous getCurrent snapshot.
    const source = new SnapshotOnlyStatusSource("online");
    const { container } = render(
      <NotebookConnectionIdentity capabilities={cloudCapabilities()} connectionStatus$={source} />,
    );
    expect(slotElement(container).dataset.state).toBe("online");
  });

  it("announces status CHANGES politely, never the initial state", () => {
    const { container, source } = renderSlot(cloudCapabilities(), "online", {
      connectionLabel: "Live room",
    });
    // Mounting must not speak.
    expect(liveRegion(container).textContent).toBe("");

    act(() => source.next("reconnecting"));
    expect(liveRegion(container).textContent).toBe("Live room: Reconnecting");

    act(() => source.next("online"));
    expect(liveRegion(container).textContent).toBe("Live room: Connected");
  });

  it("hides the avatar from the a11y tree so sr-only copy is the accessible text", () => {
    // Without aria-hidden, SR users would hear "AL Alice — Connected".
    const { container } = renderSlot(cloudCapabilities());
    const avatar = container.querySelector('[data-slot="notebook-actor-avatar"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.closest('[aria-hidden="true"]')).not.toBeNull();

    const srOnly = slotElement(container).querySelector(".sr-only");
    expect(srOnly?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("unsubscribes from the source on unmount", () => {
    const { source, unmount } = renderSlot(cloudCapabilities(), "online");
    expect(source.listenerCount).toBe(1);

    unmount();
    expect(source.listenerCount).toBe(0);
    // Late emissions are inert (no listener left to call).
    source.next("offline");
  });

  it("uses the flat quiet treatment, never a raised bubble — across the whole subtree", () => {
    const { container } = renderSlot(cloudCapabilities());
    const slot = slotElement(container);

    expect(slot.classList.contains("rounded-md")).toBe(true);
    expect(slot.classList.contains("border-border/70")).toBe(true);
    expect(slot.classList.contains("bg-muted/35")).toBe(true);
    // The pulled designs' raised-bubble look must never come back. The
    // wrapper must not be a pill (Avatar internals are legitimately
    // rounded-full), and NOTHING in the subtree may carry a shadow.
    expect(slot.classList.contains("rounded-full")).toBe(false);
    for (const element of [slot, ...Array.from(slot.querySelectorAll("*"))]) {
      for (const token of Array.from(element.classList)) {
        expect(token.startsWith("shadow")).toBe(false);
      }
    }
  });

  it("is icon-only at every width: no visible text pill", () => {
    // Collapse-proof by construction — there is no label to truncate.
    // Clone-and-strip covers the wrapper's own text nodes and every
    // nesting depth: remove sr-only copy and the avatar initials, then
    // nothing visible may remain.
    const { container } = renderSlot(cloudCapabilities());
    const slot = slotElement(container);

    const clone = slot.cloneNode(true) as HTMLElement;
    for (const hidden of Array.from(
      clone.querySelectorAll('.sr-only, [data-slot="avatar-fallback"]'),
    )) {
      hidden.remove();
    }
    expect(clone.textContent?.trim()).toBe("");

    // The avatar fallback (initials) is the only visible glyph.
    const fallback = slot.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback?.textContent).toBe("AL");
  });

  it("renders the actor avatar from the shared identity projection", () => {
    const { container } = renderSlot(cloudCapabilities());
    const slot = slotElement(container);
    expect(slot.dataset.actorKind).toBe("human");
    expect(slot.querySelector('[data-slot="notebook-actor-avatar"]')).not.toBeNull();
  });
});

describe("isRemoteNotebookContext", () => {
  it("treats cloud access as remote and local-only sessions as local", () => {
    expect(isRemoteNotebookContext(cloudCapabilities())).toBe(true);
    expect(isRemoteNotebookContext(localCapabilities())).toBe(false);
  });

  it("treats a runtime-peer compute target as remote even with local access", () => {
    expect(isRemoteNotebookContext(runtimePeerCapabilities())).toBe(true);
  });
});
