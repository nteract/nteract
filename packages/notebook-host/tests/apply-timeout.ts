import { expect, vi } from "vite-plus/test";
import { FrameType, NotebookClient, type NotebookResponse, type NotebookTransport } from "runtimed";

// Exercise the picker's real request and its host timer, not just the policy function.
export async function expectLaunchBudgetForApply(
  transport: NotebookTransport,
  deliver: (frame: Uint8Array<ArrayBuffer>) => void,
): Promise<void> {
  vi.useFakeTimers();
  const send = vi.spyOn(transport, "sendFrame");
  try {
    const client = new NotebookClient({ transport });
    const pending = client.applyEnvironmentSelection(1, ["head-a"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(299_999);

    expect(send).toHaveBeenCalledTimes(1);
    const [frameType, payload] = send.mock.calls[0];
    expect(frameType).toBe(FrameType.REQUEST);
    const envelope = JSON.parse(new TextDecoder().decode(payload));
    expect(envelope).toMatchObject({
      action: "apply_environment_selection",
      expected_revision: 1,
      observed_heads: ["head-a"],
      required_heads: ["head-a"],
    });
    const { id } = envelope;
    const response = {
      result: "environment_selection",
      selection: { revision: 2, selected: null, applied: null, applying: false },
    } satisfies NotebookResponse;
    const reply = new TextEncoder().encode(JSON.stringify({ id, ...response }));
    const frame = new Uint8Array(1 + reply.length);
    frame[0] = FrameType.RESPONSE;
    frame.set(reply, 1);
    deliver(frame);
    await expect(pending).resolves.toEqual(response);

    // Unlike Apply, reading the picker state still uses the normal deadline.
    const read = client.getEnvironmentSelection().catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(read).resolves.toEqual(
      new Error("Request timeout after 30000ms: get_environment_selection"),
    );

    const stalled = client.applyEnvironmentSelection(2, ["head-b"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(stalled).resolves.toEqual(
      new Error("Request timeout after 300000ms: apply_environment_selection"),
    );
  } finally {
    send.mockRestore();
    vi.useRealTimers();
    transport.disconnect();
  }
}
