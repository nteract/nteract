import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudCreateAttempt } from "../cloud-create-attempt";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup() {
  let account: string | null = "account-a";
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    () => new Promise(() => {}),
  );
  const navigate = vi.fn();
  const driver = new CloudCreateAttempt({
    context: () => ({
      account,
      endpoint: "https://cloud.test/api/n",
      ready: account !== null,
    }),
    fetch,
    navigate,
    origin: "https://cloud.test",
  });
  return {
    driver,
    fetch,
    navigate,
    setAccount(value: string | null) {
      account = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("CloudCreateAttempt", () => {
  it("bounds a noncooperative never-settling fetch and suppresses a second POST", () => {
    vi.useFakeTimers();
    const f = setup();
    f.driver.submit("Title");
    f.driver.submit("Different title");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.fetch.mock.calls[0]![1].body as string)).toEqual({ title: "Title" });
    vi.advanceTimersByTime(29_999);
    expect(f.driver.snapshot.state).toBe("creating");
    vi.advanceTimersByTime(1);
    expect(f.driver.snapshot).toMatchObject({
      state: "unconfirmed",
      submittedTitle: "Title",
      previousOutcomeUnknown: true,
    });
    expect(f.fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    f.driver.submit("Unsafe retry");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.driver.dispose();
  });

  it.each([201, 503])("uses the original deadline for stalled %i response body", async (status) => {
    vi.useFakeTimers();
    const f = setup();
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    const response = new Response("{}", { status });
    response.json = () => body.promise;
    f.fetch.mockReturnValue(headers.promise);
    f.driver.submit("Title");
    await vi.advanceTimersByTimeAsync(29_000);
    headers.resolve(response);
    await settle();
    vi.advanceTimersByTime(1_000);
    expect(f.driver.snapshot.state).toBe("unconfirmed");
    body.resolve({ ok: true, notebook_id: "nb", viewer_url: "/n/nb/notebook" });
    await settle();
    expect(f.navigate).not.toHaveBeenCalled();
    f.driver.dispose();
  });

  it("navigates a valid result to the canonical notebook ID route", async () => {
    const f = setup();
    f.fetch.mockResolvedValue(
      Response.json({
        ok: true,
        notebook_id: "nb-one",
        viewer_url: "/n/nb-one/Quarter%201%2F2",
      }),
    );
    f.driver.submit("Title");
    await settle();
    expect(f.navigate).toHaveBeenCalledWith("https://cloud.test/n/nb-one/notebook?mode=edit");
    f.driver.dispose();
  });

  it("accepts the existing create response edit-mode query and navigates", async () => {
    const f = setup();
    f.fetch.mockResolvedValue(
      Response.json({
        ok: true,
        notebook_id: "nb-one",
        viewer_url: "/n/nb-one/Confirmed%20title?mode=edit",
      }),
    );
    f.driver.submit("Title");
    await settle();
    expect(f.navigate).toHaveBeenCalledWith("https://cloud.test/n/nb-one/notebook?mode=edit");
    expect(f.driver.snapshot.state).toBe("ready");
    f.driver.dispose();
  });

  it("keeps creation unconfirmed after commit with lost client confirmation", async () => {
    const f = setup();
    const committed = deferred<Response>();
    f.fetch.mockReturnValue(committed.promise);
    f.driver.submit("Title");
    committed.reject(new TypeError("Load failed"));
    await settle();
    expect(f.driver.snapshot.state).toBe("unconfirmed");
    expect(f.navigate).not.toHaveBeenCalled();
    f.driver.submit("Unsafe second POST");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.driver.dispose();
  });

  it("clears the dialog warning on dismissal but records the earlier unknown outcome", () => {
    const f = setup();
    f.driver.submit("Previous title");
    f.driver.dismiss("Untitled notebook");
    expect(f.driver.snapshot).toEqual({
      state: "ready",
      submittedTitle: "Untitled notebook",
      previousOutcomeUnknown: true,
    });
    f.driver.submit("New intentional title");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.driver.dispose();
  });

  it("preserves pending intent through stable same-account hydration and credential renewal", async () => {
    let context = {
      account: "legacy-session:cookie-one",
      credentialKey: "cookie-one",
      endpoint: "https://cloud.test/api/n",
      ready: true,
    };
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const pending = deferred<Response>();
    fetch.mockReturnValue(pending.promise);
    const navigate = vi.fn();
    const driver = new CloudCreateAttempt({
      context: () => context,
      fetch,
      navigate,
      origin: "https://cloud.test",
    });
    driver.submit("Retained title");
    context = { ...context, account: "account:stable", credentialKey: "cookie-one" };
    driver.syncContext();
    context = { ...context, credentialKey: "cookie-two" };
    driver.syncContext();
    pending.resolve(Response.json({ ok: true, notebook_id: "nb", viewer_url: "/n/nb/notebook" }));
    await settle();
    expect(driver.snapshot).toMatchObject({ state: "ready", submittedTitle: "Retained title" });
    expect(navigate).toHaveBeenCalledWith("https://cloud.test/n/nb/notebook?mode=edit");
    driver.dispose();
  });

  it("does not infer same account from a rotating legacy credential key", () => {
    let context = {
      account: "legacy-session:cookie-one",
      credentialKey: "cookie-one",
      endpoint: "https://cloud.test/api/n",
      ready: true,
    };
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () => new Promise(() => {}),
    );
    const driver = new CloudCreateAttempt({
      context: () => context,
      fetch,
      navigate: vi.fn(),
      origin: "https://cloud.test",
    });
    driver.submit("Private title");
    context = { ...context, account: "legacy-session:cookie-two", credentialKey: "cookie-two" };
    driver.syncContext();
    expect(driver.snapshot).toMatchObject({
      state: "unconfirmed",
      submittedTitle: "Private title",
    });
    driver.submit("Unsafe new POST");
    expect(fetch).toHaveBeenCalledTimes(1);
    driver.dispose();
  });

  it.each(["dismiss", "account", "dispose"])("ignores late completion after %s", async (action) => {
    const f = setup();
    const pending = deferred<Response>();
    f.fetch.mockReturnValue(pending.promise);
    f.driver.submit("Title");
    if (action === "dismiss") f.driver.dismiss();
    else if (action === "dispose") f.driver.dispose();
    else {
      f.setAccount("account-b");
      f.driver.syncContext();
    }
    pending.resolve(Response.json({ ok: true, notebook_id: "nb", viewer_url: "/n/nb/notebook" }));
    await settle();
    expect(f.navigate).not.toHaveBeenCalled();
    if (action === "dismiss") expect(f.driver.snapshot.state).toBe("ready");
    if (action === "account")
      expect(f.driver.snapshot).toMatchObject({ state: "ready", submittedTitle: "" });
    f.driver.dispose();
  });
});
