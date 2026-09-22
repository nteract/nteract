import { useEffect, useLayoutEffect, useRef } from "react";
import { BehaviorSubject } from "rxjs";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import {
  EMPTY_PEOPLE_SEARCH,
  normalizePeopleQuery,
  peopleSearchAuthKey,
  type CloudPeopleSearchInputs,
  type CloudPeopleSearchState,
} from "./cloud-people-search-store";
import { useCloudStores } from "./cloud-stores-context";
import { fetchWithCloudPrototypeAuth } from "./collaborator-auth";

export function useCloudPeopleSearch(input: CloudPeopleSearchInputs): CloudPeopleSearchState {
  const { user } = useCloudStores();
  const inputsRef = useRef<BehaviorSubject<CloudPeopleSearchInputs> | null>(null);
  if (!inputsRef.current) inputsRef.current = new BehaviorSubject(input);
  const inputs$ = inputsRef.current;
  useLayoutEffect(() => inputs$.next(input));
  useEffect(
    () =>
      user.peopleSearch.activate(inputs$, {
        fetchPeople: (url, signal) =>
          fetchWithCloudPrototypeAuth(
            url,
            { headers: { Accept: "application/json" }, signal },
            inputs$.getValue().auth,
          ),
      }),
    [inputs$, user],
  );
  const state = useObservableProjection(user.peopleSearch.state$);
  // Never paint a previous account or query while effects catch up.
  if (!input.open || state.authKey !== peopleSearchAuthKey(input.auth)) return EMPTY_PEOPLE_SEARCH;
  return state.query === normalizePeopleQuery(input.query)
    ? state
    : { ...state, query: normalizePeopleQuery(input.query), people: [] };
}
