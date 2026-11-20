// A Page or Project open that the host refuses because this account can't
// read the target gets its own screen, in place of an error banner over the
// library. The host answers a missing Page and a Page the caller can't read
// with the same `page_access_denied` (shared/admission.mjs), and a missing
// Project and an unreadable one with the same `project_not_found`, so the
// screen never says the target exists.
//
//   none ─refused─▶ shown ─cleared─▶ none
//
// States:
// - none: no refusal on screen.
// - shown: `{ kind, targetId, principal }`. `kind` is "page" or "project",
//   `targetId` the id the address named, and `principal` the account the
//   host refused. The driver shows it only while that account is signed in.
//
// Events:
// - refused `{ refusal }`: noAccessRefusal's answer for a failed open. A
//   newer refusal replaces the one on screen.
// - cleared: a navigation started, or the signed-in account changed.
//
// No effects: the screen's one action, going to the library, is a
// navigation the driver owns.

export const STATES = Object.freeze(["none", "shown"]);
export const EVENTS = Object.freeze(["refused", "cleared"]);
export const NO_ACCESS_INITIAL = Object.freeze({ name: "none" });

/** The next state. Pure: an event that changes nothing returns the same
 * state object. */
export function noAccessStep(state, event) {
  if (!STATES.includes(state?.name)) throw Error(`Unknown no-access state ${state?.name}`);
  switch (event?.type) {
    case "refused": {
      const { kind, targetId, principal } = event.refusal ?? {};
      if ((kind !== "page" && kind !== "project") || !targetId || !principal) return state;
      return { name: "shown", kind, targetId, principal };
    }
    case "cleared":
      return state.name === "none" ? state : NO_ACCESS_INITIAL;
  }
  throw Error(`Unknown no-access event ${event?.type}`);
}

const pageDenied = (error) => error?.status === 403 && error.code === "page_access_denied";
const projectMissing = (error) => error?.status === 404 && error.code === "project_not_found";

/** Whether a failed open is this account being unable to read its target,
 * as `{ kind, targetId, principal }` for the `refused` event, or null when
 * the error belongs elsewhere: a format refusal (unopened-page.mjs), a Page
 * in Trash, a 401 (the sign-in prompt), a transient failure (the banner), or
 * an open that is no longer `current` because the person navigated away.
 * `projectId` is set for a Project address, where only get_project's
 * project_not_found counts. Once get_project has answered, the Project
 * exists and this account reads it, so a refusal from its content Page keeps
 * the banner and the Project's retry screen. */
export function noAccessRefusal(error, { current, pageId, projectId, principal }) {
  if (!current || !principal) return null;
  if (projectId)
    return projectMissing(error) ? { kind: "project", targetId: projectId, principal } : null;
  return pageId && pageDenied(error) ? { kind: "page", targetId: pageId, principal } : null;
}

export const NO_ACCESS_HEADING = "No access";

/** The screen's body: what the refusal means for `kind`, then the signed-in
 * account by the name its menu shows. `accountName` is null when the menu
 * has no name to show, and the sentence naming it is left out. */
export function noAccessMessage(kind, accountName) {
  const noun = kind === "project" ? "Project" : "Page";
  const refusal = `This ${noun} doesn't exist, or it isn't shared with your account.`;
  return accountName ? `${refusal} You're signed in as ${accountName}.` : refusal;
}
