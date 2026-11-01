// One stable color per participant, from nteract's cursor palette. The key is
// principal plus driver, so two agents on one account get different colors.
import {
  peerColor,
  readableForegroundForColor,
} from "../../../../../../packages/runtimed/src/notebook-actor-color.ts";

// The session label joins the key when present, so two labeled sessions of one
// account and harness get different colors; unlabeled keys are unchanged.
export function presenceColor(principal, driver, agent) {
  const base = `${principal ?? ""}/${(driver ?? "").toLowerCase()}`;
  const background = peerColor(agent ? `${base}/${agent}` : base);
  return { background, foreground: readableForegroundForColor(background) };
}
