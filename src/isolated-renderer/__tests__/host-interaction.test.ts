import { describe, expect, it, vi } from "vite-plus/test";
import {
  dispatchHostOutsideInteractionOnRelease,
  NTERACT_HOST_OUTSIDE_INTERACTION_EVENT,
} from "../host-interaction";

describe("isolated renderer host interaction bridge", () => {
  it("dispatches the outside-interaction event only when active interaction is released", () => {
    const dispatchEvent = vi.fn();
    const target = { dispatchEvent } as unknown as Window;

    dispatchHostOutsideInteractionOnRelease(false, false, target);
    dispatchHostOutsideInteractionOnRelease(false, true, target);

    expect(dispatchEvent).not.toHaveBeenCalled();

    dispatchHostOutsideInteractionOnRelease(true, false, target);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as Event;
    expect(event.type).toBe(NTERACT_HOST_OUTSIDE_INTERACTION_EVENT);
  });
});
