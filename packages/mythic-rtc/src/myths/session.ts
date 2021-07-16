import { ImmutableNotebook } from "@nteract/commutable";
import { KernelRef } from "@nteract/types";
import { collaboration } from "../package";

export const joinSession = collaboration.createMyth("join")<{
  filePath: string,
  notebook: ImmutableNotebook,
  kernelRef: KernelRef
}>({
  thenDispatch: [
    (action, state) => {
      const { filePath, notebook, kernelRef } = action.payload;
      return state.driver.join(filePath, notebook, kernelRef);
    }
  ]
});

export const leaveSession = collaboration.createMyth("leave")<void>({
  thenDispatch: [(action, state) => state.driver.leave()]
});

export const joinSessionSucceeded = collaboration.createMyth("join/succeeded")<void>({
  reduce: (state) => {
    return state.set("isLoaded", true);
  }
});

export const joinSessionFailed = collaboration.createMyth("join/failed")<void>({
  reduce: (state) => {
    return state.set("isLoaded", false);
  }
});
