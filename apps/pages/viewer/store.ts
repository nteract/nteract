import type { Snapshot } from "../src/document.ts";
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
  private state: State = {
    accountKey: null,
    ready: false,
    signedIn: false,
    name: "",
    pages: [],
    page: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private selection = 0;
  private account: string | null = null;
  private creationKey: string | null = null;
  private requestedPageId: string | null = null;
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
        this.epoch++;
        this.creationKey = null;
        this.requestedPageId = null;
        this.publish({ accountKey: null, ready: true, signedIn: false, pages: [], page: null });
        return;
      }
      if (this.account && this.account !== session.account_key) {
        this.epoch++;
        this.selection++;
        this.creationKey = null;
        this.account = session.account_key;
        this.requestedPageId = null;
        history.replaceState(null, "", "/");
        this.publish({ accountKey: session.account_key, page: null, pages: [] });
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
      const { pages } = await this.tool<{ pages: Entry[] }>("list_pages");
      if (epoch !== this.epoch) return;
      this.publish({ pages, error: null });
      const id =
        this.requestedPageId ??
        this.state.page?.page_id ??
        new URLSearchParams(location.search).get("page") ??
        pages[0]?.page_id;
      if (id) await this.open(id);
    } catch (error) {
      if (epoch === this.epoch)
        this.publish({
          ready: true,
          error: String(error instanceof Error ? error.message : error),
        });
    }
  }
  async open(id: string) {
    this.requestedPageId = id;
    const epoch = this.epoch,
      selection = ++this.selection;
    const { content } = await this.tool<{ content: Snapshot }>("read_page", { page_id: id });
    if (epoch !== this.epoch || selection !== this.selection) return;
    this.publish({ page: content });
    history.replaceState(null, "", `/?page=${encodeURIComponent(id)}`);
  }
  async create() {
    const epoch = this.epoch;
    this.creationKey ??= crypto.randomUUID();
    const { page_id } = await this.tool<{ page_id: string }>("create_page", {
      idempotency_key: this.creationKey,
      title: "Untitled",
      block_units: [{ markdown: "Start with a thought." }],
    });
    if (epoch !== this.epoch) return;
    this.creationKey = null;
    await this.open(page_id);
    await this.refresh();
  }
  async signOut() {
    const response = await fetch("/api/auth/session", { method: "POST" });
    if (!response.ok) throw new Error("Could not sign out");
    this.epoch++;
    this.selection++;
    this.account = null;
    this.creationKey = null;
    this.requestedPageId = null;
    this.publish({ accountKey: null, signedIn: false, page: null, pages: [], error: null });
    history.replaceState(null, "", "/");
  }
}
export const store = new PagesStore();
