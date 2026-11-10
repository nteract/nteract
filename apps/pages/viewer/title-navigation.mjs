/** A creation-only focus request must not follow navigation into another Page. */
export function focusCreatedPageTitle(input, createdSession, activeSession) {
  if (
    !createdSession ||
    createdSession !== activeSession ||
    !activeSession.canWrite ||
    !input?.isConnected ||
    input.readOnly
  )
    return false;
  input.focus({ preventScroll: true });
  input.select();
  return true;
}

export function titleHandsOffToBody(event, canWrite) {
  return Boolean(
    canWrite &&
    event.key === "Enter" &&
    !event.isComposing &&
    !event.nativeEvent?.isComposing &&
    event.keyCode !== 229 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey,
  );
}
