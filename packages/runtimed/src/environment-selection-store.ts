import type { Observable, Subscription } from "rxjs";
import { ObservableStore } from "./observable-store";
import type { NotebookClient } from "./notebook-client";
import type {
  CondaEnvironmentInventory,
  EnvironmentSelectionSnapshot,
  InstalledCondaPackageInventory,
  LocalEnvironmentTarget,
  NotebookResponse,
} from "./request-types";

export interface EnvironmentSelectionState {
  selection: EnvironmentSelectionSnapshot | null;
  inventory: CondaEnvironmentInventory | null;
  installedPackages: InstalledCondaPackageInventory | null;
  loadingSelection: boolean;
  loadingInventory: boolean;
  loadingInstalledPackages: boolean;
  installedPackagesError: string | null;
  mutating: boolean;
  error: string | null;
}

function initialState(): EnvironmentSelectionState {
  return {
    selection: null,
    inventory: null,
    installedPackages: null,
    loadingSelection: false,
    loadingInventory: false,
    loadingInstalledPackages: false,
    installedPackagesError: null,
    mutating: false,
    error: null,
  };
}

function responseError(response: NotebookResponse): string {
  if (response.result === "error" || response.result === "environment_selection_rejected")
    return response.error;
  if (response.result === "guard_rejected") return response.reason;
  return `Unexpected environment response: ${response.result}`;
}

/**
 * Attachment-owned mirror of daemon selection, never an independent authority.
 * Epochs fence replies from a previous connection; revisions fence delayed reads
 * against Owner notifications. Inventory is requested only by explicit UI action.
 * Disposing forgets local paths without clearing the daemon's runtime session.
 */
export class EnvironmentSelectionStore extends ObservableStore<EnvironmentSelectionState> {
  private client: NotebookClient | null = null;
  private subscription: Subscription | null = null;
  private epoch = 0;
  private inventoryRequest = 0;
  private selectionRequest = 0;
  private installedPackagesRequest = 0;

  constructor() {
    super(initialState());
  }

  get generation(): number {
    return this.epoch;
  }

  activate({
    client,
    broadcasts$,
  }: {
    client: NotebookClient;
    broadcasts$: Observable<unknown>;
  }): void {
    this.dispose();
    this.client = client;
    this.setState({
      ...this.snapshot,
      installedPackages: null,
      installedPackagesError: null,
      loadingInstalledPackages: false,
    });
    const epoch = this.epoch;
    this.subscription = broadcasts$.subscribe((payload) => {
      if (
        this.epoch !== epoch ||
        typeof payload !== "object" ||
        payload === null ||
        !("event" in payload) ||
        payload.event !== "environment_selection_changed" ||
        !("selection" in payload)
      )
        return;
      const selection = payload.selection as EnvironmentSelectionSnapshot;
      if (
        !selection ||
        !Number.isSafeInteger(selection.revision) ||
        typeof selection.applying !== "boolean"
      )
        return;
      this.acceptSelection(selection);
    });
    void this.refreshSelection();
  }

  dispose(): void {
    this.epoch++;
    this.inventoryRequest++;
    this.installedPackagesRequest++;
    this.selectionRequest++;
    this.setState({
      ...this.snapshot,
      installedPackages: null,
      installedPackagesError: null,
      loadingInstalledPackages: false,
    });
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.client = null;
    this.resetState(initialState());
  }

  private acceptSelection(selection: EnvironmentSelectionSnapshot): void {
    if (this.snapshot.selection && selection.revision <= this.snapshot.selection.revision) return;
    this.setState({ ...this.snapshot, selection });
  }

  async refreshSelection(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const epoch = this.epoch;
    const request = ++this.selectionRequest;
    const revision = this.snapshot.selection?.revision;
    const isCurrent = () => epoch === this.epoch && request === this.selectionRequest;
    const hasNewerSelection = () => this.snapshot.selection?.revision !== revision;
    this.setState({ ...this.snapshot, loadingSelection: true, error: null });
    try {
      const response = await client.getEnvironmentSelection();
      if (!isCurrent()) return;
      if (response.result === "environment_selection") this.acceptSelection(response.selection);
      else if (!hasNewerSelection())
        this.setState({ ...this.snapshot, error: responseError(response) });
    } catch (error) {
      if (isCurrent() && !hasNewerSelection())
        this.setState({
          ...this.snapshot,
          error: String(error instanceof Error ? error.message : error),
        });
    } finally {
      if (isCurrent()) this.setState({ ...this.snapshot, loadingSelection: false });
    }
  }

  async loadInventory(refresh: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    const epoch = this.epoch;
    const request = ++this.inventoryRequest;
    const isCurrent = () => epoch === this.epoch && request === this.inventoryRequest;
    this.setState({ ...this.snapshot, loadingInventory: true, error: null });
    try {
      const response = await client.listCondaEnvironments(refresh);
      if (!isCurrent()) return;
      if (response.result === "conda_environments")
        this.setState({ ...this.snapshot, inventory: response.inventory });
      else this.setState({ ...this.snapshot, error: responseError(response) });
    } catch (error) {
      if (isCurrent())
        this.setState({
          ...this.snapshot,
          error: String(error instanceof Error ? error.message : error),
        });
    } finally {
      if (isCurrent()) this.setState({ ...this.snapshot, loadingInventory: false });
    }
  }

  async loadInstalledPackages(refresh: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    const epoch = this.epoch;
    const request = ++this.installedPackagesRequest;
    const isCurrent = () => epoch === this.epoch && request === this.installedPackagesRequest;
    this.setState({
      ...this.snapshot,
      loadingInstalledPackages: true,
      installedPackagesError: null,
    });
    try {
      const response = await client.listInstalledCondaPackages(refresh);
      if (!isCurrent()) return;
      if (response.result === "installed_conda_packages")
        this.setState({
          ...this.snapshot,
          installedPackages: response.inventory,
          installedPackagesError: null,
        });
      else this.setState({ ...this.snapshot, installedPackagesError: responseError(response) });
    } catch (error) {
      if (isCurrent())
        this.setState({
          ...this.snapshot,
          installedPackagesError: String(error instanceof Error ? error.message : error),
        });
    } finally {
      if (isCurrent()) this.setState({ ...this.snapshot, loadingInstalledPackages: false });
    }
  }

  async loadInstalledPackagesForRunningEnvironment(
    runningEnvironmentId: string | null,
    runtimeIsRunning: boolean,
  ): Promise<void> {
    const selection = this.snapshot.selection;
    const applied = selection?.applied;
    if (
      !selection ||
      !runtimeIsRunning ||
      !runningEnvironmentId ||
      selection.applying ||
      !applied ||
      selection.selected?.id !== applied.id ||
      applied.id !== runningEnvironmentId
    ) {
      return;
    }
    if (
      this.snapshot.installedPackages ||
      this.snapshot.loadingInstalledPackages ||
      this.snapshot.installedPackagesError
    ) {
      return;
    }
    await this.loadInstalledPackages(false);
  }

  clearInstalledPackages(): void {
    this.installedPackagesRequest++;
    if (
      !this.snapshot.installedPackages &&
      !this.snapshot.loadingInstalledPackages &&
      !this.snapshot.installedPackagesError
    )
      return;
    this.setState({
      ...this.snapshot,
      installedPackages: null,
      installedPackagesError: null,
      loadingInstalledPackages: false,
    });
  }

  async setSelection(target: LocalEnvironmentTarget): Promise<boolean> {
    const client = this.client;
    const selection = this.snapshot.selection;
    if (!client || !selection || selection.applying || this.snapshot.mutating) return false;
    const epoch = this.epoch;
    this.setState({ ...this.snapshot, mutating: true, error: null });
    try {
      const response = await client.setEnvironmentSelection(target, selection.revision);
      if (epoch !== this.epoch) return false;
      if (response.result === "environment_selection") {
        this.acceptSelection(response.selection);
        return true;
      }
      const error = responseError(response);
      await this.refreshSelection();
      if (epoch === this.epoch) this.setState({ ...this.snapshot, error });
      return false;
    } catch (error) {
      if (epoch === this.epoch)
        this.setState({
          ...this.snapshot,
          error: String(error instanceof Error ? error.message : error),
        });
      return false;
    } finally {
      if (epoch === this.epoch) this.setState({ ...this.snapshot, mutating: false });
    }
  }

  async apply(
    expectedRevision: number,
    observedHeads: string[],
    generation: number,
  ): Promise<NotebookResponse> {
    const client = this.client;
    if (
      !client ||
      generation !== this.epoch ||
      this.snapshot.selection?.revision !== expectedRevision ||
      this.snapshot.selection.applying ||
      this.snapshot.mutating
    ) {
      return {
        result: "environment_selection_rejected",
        error: "The environment selection changed. Review it and apply again.",
      };
    }
    const epoch = this.epoch;
    this.setState({ ...this.snapshot, mutating: true, error: null });
    try {
      const response = await client.applyEnvironmentSelection(expectedRevision, observedHeads);
      if (epoch !== this.epoch)
        return {
          result: "environment_selection_rejected",
          error: "The notebook connection changed. Apply again when connected.",
        };
      if (response.result === "environment_selection") this.acceptSelection(response.selection);
      else {
        const error = responseError(response);
        await this.refreshSelection();
        if (epoch === this.epoch) this.setState({ ...this.snapshot, error });
      }
      return response;
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (epoch === this.epoch) this.setState({ ...this.snapshot, error: message });
      return { result: "environment_selection_rejected", error: message };
    } finally {
      if (epoch === this.epoch) this.setState({ ...this.snapshot, mutating: false });
    }
  }
}
