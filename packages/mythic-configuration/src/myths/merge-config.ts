import { fromJS } from "immutable";
import { configuration } from "../package";

export const mergeConfig = configuration.createMyth("mergeConfig")<object>({
  reduce: (state, action) =>
    state.set("current", state.current.merge(fromJS(action.payload))),
});