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
      target: { kind: "local_daemon", status: "connected" },
    },
  });
}

function renderSlot(
  caps: NotebookShellCapabilities,
  status: ConnectionStatus = "online",
): { container: HTMLElement; source: FakeStatusSource } {
  const source = new FakeStatusSource(status);
  const { container } = render(
    <NotebookConnectionIdentity capabilities={caps} connectionStatus$={source} />,
  );
  return { container, source };
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

describe("NotebookConnectionIdentity", () => {
  it("renders nothing for a purely local desktop session", () => {
    // Conditionality is the point (#3290): local identity is noise, not chrome.
    const { container } = renderSlot(localCapabilities());
    expect(container.innerHTML).toBe("");
  });

  it("renders for a local session attached to a runtime peer", () => {
    const caps = localCapabilities();
    const { container } = renderSlot(
      capabilities({
        ...caps,
        access: caps.access,
        runtime: {
          ...caps.runtime,
          source: "cloud",
          target: { kind: "runtime_peer", status: "connected" },
        },
      }),
    );
    expect(slotElement(container)).toBeTruthy();
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
      expect(dot.className).toContain(tone);
      expect(dot.className.includes("animate-pulse")).toBe(pulses);
      // State expresses as opacity/dot color, never copy: non-online dims.
      expect(slot.className.includes("opacity-60")).toBe(status !== "online");
      // Detail lives in sr-only copy and the title tooltip only.
      expect(slot.title).toContain(label);
      const srOnly = slot.querySelector(".sr-only");
      expect(srOnly?.textContent).toContain(label);
      expect(srOnly?.textContent).toContain("Alice");
    },
  );

  it("keeps the dot live through a reconnect loop (stale-chrome motivation)", () => {
    // Runtime-state stores are not blanked while the transport reconnects;
    // the dot is what makes the frozen chrome interpretable, so it must
    // track the loop rather than only steady states.
    const { container, source } = renderSlot(cloudCapabilities(), "online");
    expect(slotElement(container).dataset.state).toBe("online");

    act(() => source.next("reconnecting"));
    expect(slotElement(container).dataset.state).toBe("reconnecting");
    expect(dotElement(container).className).toContain("animate-pulse");

    act(() => source.next("online"));
    expect(slotElement(container).dataset.state).toBe("online");
    expect(dotElement(container).className).toContain("bg-emerald-500");
  });

  it("uses the flat quiet treatment, never a raised bubble", () => {
    const { container } = renderSlot(cloudCapabilities());
    const slot = slotElement(container);

    expect(slot.className).toContain("rounded-md");
    expect(slot.className).toContain("border-border/70");
    expect(slot.className).toContain("bg-muted/35");
    // The pulled designs' raised-bubble look must never come back.
    expect(slot.className).not.toContain("rounded-full");
    expect(slot.className).not.toContain("shadow");
  });

  it("is icon-only at every width: no visible text pill", () => {
    // Collapse-proof by construction — there is no label to truncate.
    const { container } = renderSlot(cloudCapabilities());
    const slot = slotElement(container);

    const visibleText = Array.from(slot.querySelectorAll("*"))
      .filter(
        (element) =>
          !element.classList.contains("sr-only") &&
          !element.closest('[data-slot="avatar-fallback"]'),
      )
      .flatMap((element) =>
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? ""),
      )
      .filter((text) => text.length > 0);
    expect(visibleText).toEqual([]);

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
    const caps = localCapabilities();
    expect(
      isRemoteNotebookContext(
        capabilities({
          ...caps,
          access: caps.access,
          runtime: { ...caps.runtime, target: { kind: "runtime_peer", status: "connected" } },
        }),
      ),
    ).toBe(true);
  });
});
