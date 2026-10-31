// One stable color per participant, from nteract's cursor palette. The key is
// principal plus driver, so two agents on one account get different colors.
import {
  peerColor,
  readableForegroundForColor,
} from "../../../../../../packages/runtimed/src/notebook-actor-color.ts";

export function presenceColor(principal, driver) {
  const background = peerColor(`${principal ?? ""}/${(driver ?? "").toLowerCase()}`);
  return { background, foreground: readableForegroundForColor(background) };
}
