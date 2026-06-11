export const NTERACT_HOST_OUTSIDE_INTERACTION_EVENT = "nteract:host-outside-interaction";

export function dispatchHostOutsideInteractionOnRelease(
  previousActive: boolean,
  nextActive: boolean,
  target: Window = window,
) {
  if (previousActive && !nextActive) {
    target.dispatchEvent(new Event(NTERACT_HOST_OUTSIDE_INTERACTION_EVENT));
  }
}
