import { EMPTY, catchError, concatMap, defer, type Observable, type Subscription } from "rxjs";

interface SerializedCloudCellChangesOptions<TChangeset> {
  cellChanges$: Observable<TChangeset>;
  materializeChangeset: (changeset: TChangeset) => Promise<void>;
  onMaterializationError?: (error: unknown) => void;
}

export function subscribeSerializedCloudCellChanges<TChangeset>({
  cellChanges$,
  materializeChangeset,
  onMaterializationError,
}: SerializedCloudCellChangesOptions<TChangeset>): Subscription {
  return cellChanges$
    .pipe(
      concatMap((changeset) =>
        defer(() => materializeChangeset(changeset)).pipe(
          catchError((error: unknown) => {
            onMaterializationError?.(error);
            return EMPTY;
          }),
        ),
      ),
    )
    .subscribe();
}
