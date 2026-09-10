import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CloudPresenceStatus } from "../cloud-presence-status";
import { CloudViewerPresenceStore } from "../presence";

afterEach(cleanup);

function ready(store: CloudViewerPresenceStore, peerId = "self") {
  store.reduceMessage({
    type: "cloud_room_ready",
    protocol: "v4",
    notebook_id: "fixture",
    peer_id: peerId,
    actor_label: "user:anaconda:alice/browser:tab",
    connection_scope: "owner",
    room_peer_count: 1,
    timestamp: "2026-09-10T00:00:00Z",
  });
}

function join(store: CloudViewerPresenceStore, peerId: string, anonymous = false) {
  store.reduceMessage({
    type: "cloud_peer_joined",
    notebook_id: "fixture",
    peer_id: peerId,
    actor_label: anonymous
      ? `anonymous:viewer:${peerId}/browser:tab`
      : `user:anaconda:bob/browser:${peerId}`,
    display_name: anonymous ? undefined : "Bob",
    connection_scope: "viewer",
    room_peer_count: store.getSnapshot().peers.length + 1,
    timestamp: "2026-09-10T00:00:01Z",
  });
}

describe("CloudPresenceStatus", () => {
  it("describes membership without activity badges and counts anonymous sessions explicitly", () => {
    const store = new CloudViewerPresenceStore();
    ready(store);
    join(store, "bob-a");
    join(store, "bob-b");
    join(store, "anon-a", true);
    join(store, "anon-b", true);
    const { container } = render(<CloudPresenceStatus store={store} connectionError={null} />);

    expect(
      screen.getByLabelText(
        "1 other participant and 2 anonymous viewer sessions connected; activity unknown",
      ),
    ).toBeTruthy();
    expect(screen.getByTitle("Bob — connected; activity unknown")).toBeTruthy();
    expect(
      screen.getByTitle("2 anonymous viewer sessions — connected; activity unknown"),
    ).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="avatar-badge"]')).toBeNull();
  });

  it("marks observer connection loss as unavailable and replaces membership on reconnect", () => {
    const store = new CloudViewerPresenceStore();
    ready(store);
    join(store, "bob");
    const { container } = render(<CloudPresenceStatus store={store} connectionError={null} />);

    act(() => store.reduceConnection("disconnected"));
    expect(screen.getByLabelText("Connection lost — participant status unavailable")).toBeTruthy();
    expect(screen.getByTitle("Bob — participant status unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("Offline");

    act(() => ready(store, "self-reconnected"));
    expect(container.querySelector('[data-slot="cloud-presence-stack"]')).toBeNull();
    expect(store.getSnapshot().peers.map((peer) => peer.id)).toEqual(["self-reconnected"]);
  });

  it("removes only a departed session while another tab of that participant remains", () => {
    const store = new CloudViewerPresenceStore();
    ready(store);
    join(store, "bob-a");
    join(store, "bob-b");
    const { container } = render(<CloudPresenceStatus store={store} connectionError={null} />);
    const leave = (peerId: string, count: number) =>
      store.reduceMessage({
        type: "cloud_peer_left",
        notebook_id: "fixture",
        peer_id: peerId,
        actor_label: `user:anaconda:bob/browser:${peerId}`,
        room_peer_count: count,
        timestamp: "2026-09-10T00:00:02Z",
      });
    act(() => leave("bob-a", 2));
    expect(screen.getByTitle("Bob — connected; activity unknown")).toBeTruthy();
    act(() => leave("bob-b", 1));
    expect(container.querySelector('[data-slot="cloud-presence-stack"]')).toBeNull();
  });

  it("uses joining and connection-error copy without contradicting accessible status", () => {
    const store = new CloudViewerPresenceStore();
    const { container, rerender } = render(
      <CloudPresenceStatus store={store} connectionError={null} />,
    );
    expect(screen.getByLabelText("Joining room")).toBeTruthy();
    act(() => {
      ready(store);
      join(store, "bob");
    });
    rerender(
      <CloudPresenceStatus
        store={store}
        connectionError="Failed to connect wss://example.test/sync?token=secret"
      />,
    );
    expect(screen.getByLabelText("Room unavailable: unable to join the live room")).toBeTruthy();
    expect(screen.getByTitle("Bob — participant status unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("connected; activity unknown");
    expect(container.innerHTML).not.toContain("secret");
  });
});
