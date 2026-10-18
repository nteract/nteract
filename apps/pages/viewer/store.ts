import { PageReplica, type SyncStatus } from "./replica.ts";
import type { Snapshot } from "../src/document.ts";
import type { ProjectedThread } from "../src/comments.ts";
export interface Entry {
  page_id: string;
  title: string;
  updated_at: string;
}
interface State {
  accountKey: string | null;
  ready: boolean;
  signedIn: boolean;
  name: string;
  pages: Entry[];
  page: Snapshot | null;
  error: string | null;
  syncStatus: SyncStatus;
  comments: ProjectedThread[];
}
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly commitStatus: string,
  ) {
    super(message);
  }
}
export class PagesStore {
  replica: PageReplica | null = null;
  constructor(private readonly options = { realtime: true }) {}
  private state: State = {
    accountKey: null,
    ready: false,
    signedIn: false,
    name: "",
    pages: [],
    page: null,
    error: null,
    syncStatus: "connecting",
    comments: [],
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private selection = 0;
  private catalogVersion = 0;
  private account: string | null = null;
  private creationKey: string | null = null;
  private requestedPageId: string | null = null;
  private deletion: { page_id: string; base_sequence: number; idempotency_key: string } | null =
    null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async tool<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, arguments: args }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new ToolError(
        result.error?.message || "Request failed. Retry the same edit before changing it.",
        response.status,
        result.error?.commit_status ?? "unknown",
      );
    return result as T;
  }
  async refresh() {
    const epoch = this.epoch;
    try {
      const response = await fetch("/api/auth/session");
      if (!response.ok) throw new Error("Sign-in renewal is temporarily unavailable");
      const { session } = await response.json();
      if (epoch !== this.epoch) return;
      if (!session) {
        this.replica?.dispose();
        this.replica = null;
        this.epoch++;
        this.creationKey = null;
        this.requestedPageId = null;
        this.publish({
          accountKey: null,
          ready: true,
          signedIn: false,
          pages: [],
          comments: [],
          page: null,
        });
        return;
      }
      if (this.account && this.account !== session.account_key) {
        this.replica?.dispose();
        this.replica = null;
        this.epoch++;
        this.selection++;
        this.creationKey = null;
        this.account = session.account_key;
        this.requestedPageId = null;
        history.replaceState(null, "", "/");
        this.publish({ accountKey: session.account_key, page: null, pages: [], comments: [] });
        await this.refresh();
        return;
      }
      this.account = session.account_key;
      this.publish({
        accountKey: session.account_key,
        ready: true,
        signedIn: true,
        name: session.display_name ?? "Your workspace",
      });
      const selection = this.selection,
        catalogVersion = this.catalogVersion;
      const { pages } = await this.tool<{ pages: Entry[] }>("list_pages");
      if (
        epoch !== this.epoch ||
        selection !== this.selection ||
        catalogVersion !== this.catalogVersion
      )
        return;
      this.catalogVersion++;
      this.publish({ pages, error: null });
      if (this.state.page && !pages.some((p) => p.page_id === this.state.page!.page_id))
        this.clearPage();
      const id =
        this.requestedPageId ??
        this.state.page?.page_id ??
        new URLSearchParams(location.search).get("page") ??
        pages[0]?.page_id;
      if (id && pages.some((p) => p.page_id === id)) await this.open(id);
      else if (id) {
        this.clearPage();
        this.startReplica(null);
      } else if (!this.replica) this.startReplica(null);
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({
          ready: true,
          error: String(error instanceof Error ? error.message : error),
        });
    }
  }
  private clearPage() {
    this.selection++;
    this.requestedPageId = null;
    this.replica?.dispose();
    this.replica = null;
    history.replaceState(null, "", "/");
    this.publish({ page: null, comments: [], error: null });
  }
  async open(id: string) {
    this.requestedPageId = id;
    const epoch = this.epoch,
      selection = ++this.selection;
    if (this.replica?.pageId === id) return;
    const { content } = await this.tool<{ content: Snapshot }>("read_page", { page_id: id });
    if (epoch !== this.epoch || selection !== this.selection) return;
    this.replica?.dispose();
    this.replica = null;
    this.publish({ page: content, comments: [], syncStatus: "connecting" });
    this.startReplica(id);
    history.replaceState(null, "", `/?page=${encodeURIComponent(id)}`);
  }
  private startReplica(id: string | null) {
    const epoch = this.epoch;
    if (this.options.realtime && this.account) {
      const account = this.account;
      const replica: PageReplica = new PageReplica(
        account,
        id,
        (update) => {
          if (epoch !== this.epoch || this.replica !== replica || this.account !== account) return;
          this.publish({
            ...(update.page && this.state.signedIn ? { page: update.page } : {}),
            syncStatus: update.status,
            error: update.error,
            comments: this.state.signedIn ? update.comments : [],
          });
        },
        (pages) => {
          if (epoch === this.epoch && this.replica === replica) {
            this.catalogVersion++;
            this.publish({ pages });
            if (id && !pages.some((p) => p.page_id === id)) {
              this.clearPage();
              this.startReplica(null);
              return;
            }
            if (!id && !this.requestedPageId && pages[0])
              void this.open(pages[0].page_id).catch((error) =>
                this.publish({ error: String(error) }),
              );
          }
        },
        async () => {
          const response = await fetch("/api/auth/session");
          if (!response.ok) throw Error("Sign-in renewal is temporarily unavailable");
          const { session } = await response.json();
          if (epoch !== this.epoch || this.replica !== replica) return false;
          if (!session || session.account_key !== account) {
            this.publish({
              signedIn: false,
              page: null,
              pages: [],
              comments: [],
              syncStatus: "signed_out",
            });
            return false;
          }
          this.publish({ signedIn: true });
          return true;
        },
      );
      this.replica = replica;
      replica.start();
    }
  }
  async create() {
    const epoch = this.epoch;
    this.creationKey ??= crypto.randomUUID();
    const { page_id } = await this.tool<{ page_id: string }>("create_page", {
      idempotency_key: this.creationKey,
      title: "Untitled",
      block_units: [{ markdown: "Start with a thought.", format: "automerge-rich-text-v1" }],
    });
    if (epoch !== this.epoch) return;
    this.creationKey = null;
    await this.open(page_id);
    if (!this.options.realtime) await this.refresh();
  }
  async deletePage() {
    const page = this.state.page,
      epoch = this.epoch;
    if (!page) return;
    if (this.deletion?.page_id !== page.page_id)
      this.deletion = {
        page_id: page.page_id,
        base_sequence: page.through_sequence,
        idempotency_key: crypto.randomUUID(),
      };
    try {
      await this.tool("delete_page", this.deletion);
    } catch (error) {
      if (
        epoch === this.epoch &&
        error instanceof ToolError &&
        error.commitStatus === "not_committed"
      )
        this.deletion = null;
      throw error;
    }
    if (epoch !== this.epoch) return;
    this.deletion = null;
    if (this.state.page?.page_id === page.page_id) this.clearPage();
    await this.refresh();
  }
  async reopenSaved() {
    const replica = this.replica,
      epoch = this.epoch;
    if (!replica?.pageId) return;
    await replica.discardPending();
    if (epoch !== this.epoch || this.replica !== replica) return;
    replica.dispose();
    this.replica = null;
    await this.open(replica.pageId);
  }
  async signOut() {
    const response = await fetch("/api/auth/session", { method: "POST" });
    if (!response.ok) throw new Error("Could not sign out");
    this.replica?.dispose();
    this.replica = null;
    this.epoch++;
    this.selection++;
    this.account = null;
    this.creationKey = null;
    this.deletion = null;
    this.requestedPageId = null;
    this.publish({
      accountKey: null,
      signedIn: false,
      page: null,
      pages: [],
      comments: [],
      error: null,
    });
    history.replaceState(null, "", "/");
  }
}
export const store = new PagesStore();
