import { useEffect, useLayoutEffect, useRef } from "react";
import { BehaviorSubject } from "rxjs";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { EMPTY_HIDDEN_PEOPLE } from "./cloud-hidden-people-store";
import { peopleSearchAuthKey } from "./cloud-people-search-store";
import { useCloudStores } from "./cloud-stores-context";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";

export function useCloudHiddenPeople(auth: CloudPrototypeAuthState, open: boolean) {
  const { user } = useCloudStores();
  const input = { auth, open };
  const inputsRef = useRef<BehaviorSubject<typeof input> | null>(null);
  if (!inputsRef.current) inputsRef.current = new BehaviorSubject(input);
  const inputs$ = inputsRef.current;
  useLayoutEffect(() => inputs$.next(input));
  useEffect(
    () =>
      user.hiddenPeople.activate(inputs$, {
        request: (url, init) => fetchWithCloudPrototypeAuth(url, init, inputs$.getValue().auth),
        beginMutation: () => user.peopleSearch.beginMutation(),
        endMutation: (token) => user.peopleSearch.endMutation(token),
      }),
    [inputs$, user],
  );
  const state = useObservableProjection(user.hiddenPeople.state$);
  return {
    state: state.authKey === peopleSearchAuthKey(auth) ? state : EMPTY_HIDDEN_PEOPLE,
    hide: user.hiddenPeople.hide.bind(user.hiddenPeople),
    undo: user.hiddenPeople.undo.bind(user.hiddenPeople),
    loadPage: user.hiddenPeople.loadPage.bind(user.hiddenPeople),
  };
}
