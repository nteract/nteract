import "../../../../../../src/styles/notebook-tokens.css";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  LogOut,
  Link,
  MessageSquare,
  Plus,
  Plug,
  RotateCcw,
  Search,
  Type,
  Trash2,
  UserRound,
} from "lucide-react";
import { request, tool } from "./request.mjs";
import {
  failureMessage,
  screenBanners,
  sessionAnswerNotice,
  sessionCheckBanner,
} from "./alerts.mjs";
import { listLocalPages, forgetLocalPage } from "./local-catalog.mjs";
import {
  PROJECTS_PATH,
  isIndexRoute,
  pagePath,
  pagesPath,
  readPageRoute,
  writePageRoute,
  writeRoute,
  isPlainNavigation,
  pageListing,
} from "../shared/routes.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { requestSession } from "./early-session.mjs";
import { openPageWithRetry } from "./page-open.mjs";
// app.css carries the editor's styles too, ahead of style.css so the cascade
// matches the editor modules' own import order.
import "./table-fragment.css";
import "./link-popover.css";
import "./wordgard.css";
import "./sharing-panel.css";
import "./comments.css";
import "./save-status.css";
import { PagePicker } from "./PagePicker.jsx";
import { TrashView } from "./TrashView.jsx";
import { Breadcrumbs, ProjectView } from "./ProjectView.jsx";
import { IndexNav, PagesIndex, ProjectsIndex } from "./IndexViews.jsx";
import { listProjects, pageBreadcrumbs } from "./projects.mjs";
import { closeTrashedSessions, restorePage } from "./trash.mjs";
import { listAllPages, matchingPages } from "./page-list.mjs";
import { AppearanceControls } from "./AppearanceControls.jsx";
import { retryKey } from "../model/retry-key.mjs";
import "./style.css";
import "./formatting-toolbar.css";
import { focusCreatedPageTitle, titleHandsOffToBody } from "./title-navigation.mjs";
import { BuildUpdate, buildMonitor } from "./BuildUpdate.jsx";
import { SchemaNotice } from "./SchemaNotice.jsx";
import { reloadGate } from "./build-freshness.mjs";
import { EditorLoader } from "./editor-loader.mjs";
import { SessionHost } from "./session-host.mjs";
import { useStore } from "./store.mjs";
import { CommentComposer } from "./comment-composer.mjs";
import { focusReturnTarget } from "./focus-return.mjs";
import { timer } from "rxjs";
import { MOBILE_EDITOR_QUERY, trackVisualViewport } from "./visual-viewport.mjs";

// The editor, and the WASM runtimes it waits for, load beside the shell
// from boot, except on the index routes (/projects, /pages), which only list;
// there the first Page open or creation starts it. A Page session exists only
// once it has loaded, so code that holds a session reads `editor.module`
// directly. A failed import, or a Mermaid renderer that fails to load later,
// asks the server for its build.
const editor = new EditorLoader({
  load: () =>
    import("./page-editor.mjs").then((module) => {
      module.onRendererUnavailable(() => void buildMonitor.check());
      return module;
    }),
  checkBuild: () => buildMonitor.check(),
});
if (!isIndexRoute(readPageRoute(location.href))) editor.start();
// A pointer going down on a Page row is a strong hint a Page opens next.
const warmEditor = () => editor.start();
// How long a new thread's passage stays emphasized after the inline composer
// sends it.
const CREATED_FLASH_MS = 1600;
// The sessions this tab owns. The reload gate follows them from here.
const host = new SessionHost();
reloadGate.watch(host);
const installedSession = (state) => state.current;
const editorFailed = (state) => state.name === "failed";
// The build banner already asks for a reload when the editor can't load.
const bannerShows = (error) => error?.code === "EDITOR_UNAVAILABLE";

function App() {
  const accountDisclosure = useDismissibleDisclosure(),
    documentDisclosure = useDismissibleDisclosure(),
    activityDisclosure = useDismissibleDisclosure();
  const [account, setAccount] = useState(undefined),
    [pages, setPages] = useState([]),
    [, paint] = useState(0),
    [error, setError] = useState(""),
    // The session check's banner: { message, signIn } or null.
    [sessionNotice, setSessionNotice] = useState(null),
    [notice, setNotice] = useState(""),
    [libraryQuery, setLibraryQuery] = useState(""),
    [trashOpen, setTrashOpen] = useState(false),
    [projects, setProjects] = useState([]),
    [projectOpen, setProjectOpen] = useState(null),
    // An index route: { kind: "projects" | "pages", query, visit, principal }
    // or null. `visit` remounts the listing for each navigation, Back
    // included; `query` follows the search typed on /pages.
    [index, setIndex] = useState(null),
    [crumbs, setCrumbs] = useState([]);
  const [toolbar, setToolbar] = useState(null),
    [toolbarOpen, setToolbarOpen] = useState(false),
    [active, setActive] = useState(null),
    [commentsOpen, setCommentsOpen] = useState(false),
    [target, setTarget] = useState(null),
    [pickerOpen, setPickerOpen] = useState(false),
    [pickerError, setPickerError] = useState(""),
    [creating, setCreating] = useState(false),
    [opening, setOpening] = useState(false),
    [focusBlock, setFocusBlock] = useState(null),
    [titleFocusRequest, setTitleFocusRequest] = useState(null),
    [localRecoveries, setLocalRecoveries] = useState([]);
  const session = useStore(host.store, installedSession);
  const editorUnavailable = useStore(editor.store, editorFailed);
  // Rendered only beside a session; handlers read editor.module when they run.
  const { WordgardEditor, CommentsPanel, CommentPopover, SaveStatus, PageControls } =
    editor.module ?? {};
  const auth = useRef(null),
    authentication = useRef(null),
    catalogRevision = useRef(0),
    indexVisits = useRef(0),
    lastRemote = useRef(null),
    creationPending = useRef(false),
    article = useRef(null),
    titleInput = useRef(null),
    activeBlock = useRef(null),
    commentsButton = useRef(null);
  // The inline comment composer. It outlives Pages; resetDocumentUI resets it,
  // and a send that settles after the reset is ignored by its key.
  const [composer] = useState(
    () =>
      new CommentComposer({
        send: (current, body) => {
          const session = host.current;
          if (!session) throw Error("Page closed");
          return editor.module.sendCommentDraft(session, current.draft, body);
        },
        focusComposer: () =>
          requestAnimationFrame(() =>
            document
              .querySelector('#comment-popover [role="textbox"]')
              ?.focus({ preventScroll: true }),
          ),
        // Keyboard closes only; pointer dismissals leave focus where the
        // pointer put it. The draft's block may be gone by now.
        returnFocus: (current) =>
          requestAnimationFrame(() =>
            focusReturnTarget(article.current, {
              blockIds: [current?.draft.blockId, activeBlock.current],
              title: titleInput.current,
            })?.focus({ preventScroll: true }),
          ),
        flash: (threadId) =>
          setTarget({ id: threadId, request: performance.now(), source: "created" }),
      }),
  );
  const composerState = useStore(composer.store);
  // The block whose editor holds the Page's selection, read by returnFocus.
  activeBlock.current = active;
  // True while `revision` is the latest navigation and `principal` still the
  // signed-in account.
  const navigationCurrent = (revision, principal) =>
    host.isCurrent(revision) && authentication.current?.identity?.principal === principal;
  const refresh = async () => {
    const identity = authentication.current?.identity;
    if (!identity) return [];
    const revision = ++catalogRevision.current;
    const remoteRequest = listAllPages(tool).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const closing = host.closingPages();
    const local = await listLocalPages(identity).catch(() => []);
    const stillCurrent = () =>
      identity.principal === authentication.current?.identity?.principal &&
      revision === catalogRevision.current;
    if (!stillCurrent()) return [];
    // Until this refresh's remote result arrives, the last one for this
    // account stands in for it.
    const listing = pageListing(
      lastRemote.current?.principal === identity.principal ? lastRemote.current.pages : [],
      local,
    );
    setPages(listing.pages);
    // Projects load beside the Page list; a failure leaves the list usable.
    void listProjects(tool).then(
      (value) => {
        if (stillCurrent()) setProjects(value);
      },
      () => {},
    );
    // A Page left by this navigation drains and writes its final local
    // checkpoint (title included) in the background. Relist once it lands.
    if (closing.length)
      void Promise.all(closing)
        .then(() => listLocalPages(identity))
        .then((latest) => {
          if (stillCurrent()) setPages(listing.local(latest));
        })
        .catch(() => {});
    const remote = await remoteRequest;
    if (!stillCurrent()) return [];
    if (remote.value)
      lastRemote.current = { principal: identity.principal, pages: remote.value.pages ?? [] };
    const result = listing.remote(remote.value?.pages ?? null);
    setPages(result);
    if (remote.error && !result.length) throw remote.error;
    return result;
  };
  function activateBlock(id) {
    setActive(id);
  }
  function showFormatting(open, focus = false) {
    setToolbarOpen(open);
    if (documentDisclosure.current) documentDisclosure.current.open = false;
    if (focus && open)
      requestAnimationFrame(() => {
        toolbar?.querySelector("select:not(:disabled),button:not(:disabled)")?.focus();
      });
  }
  function formattingShortcut(event) {
    if (
      session?.canWrite &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key === "F10"
    ) {
      event.preventDefault();
      event.stopPropagation();
      showFormatting(true, true);
    }
  }
  function resetDocumentUI() {
    setActive(null);
    setToolbarOpen(false);
    composer.reset();
    setTarget(null);
    setCommentsOpen(false);
    setFocusBlock(null);
    setTitleFocusRequest(null);
    setLocalRecoveries([]);
  }
  // Every banner sentence for a failed action comes from failureMessage, so
  // an unreachable server reads the same wherever it surfaced.
  const showError = (error) => setError(failureMessage(error));
  /** Leave the installed Page. It keeps syncing until its receipt (bounded)
   * so leaving never drops a save; the host tracks the close. */
  function releaseCurrent(options) {
    host.release({ ...options, onError: showError });
    resetDocumentUI();
  }
  async function install(next, revision, { focus = false } = {}) {
    if (!host.install(next, revision, authentication.current?.identity?.principal)) {
      await next.close();
      return false;
    }
    setProjectOpen(null);
    setIndex(null);
    setCrumbs([]);
    // Breadcrumbs show only the Project and parents this account can open.
    void pageBreadcrumbs(tool, next.pageId).then(
      (value) => {
        if (host.current === next) setCrumbs(value);
      },
      () => {},
    );
    next.subscribe(() => {
      if (host.current === next) {
        paint((n) => n + 1);
        if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
      }
    });
    void next
      .listRecoveries()
      .then((records) => {
        if (host.current === next) setLocalRecoveries(records);
      })
      .catch(() => {});
    if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
    const first = editor.module.orderedBlockIds(next.doc)[0] ?? null;
    activateBlock(first);
    if (focus) setFocusBlock(first);
    return true;
  }
  function reloadAccess(previous = host.current) {
    // Reload waits while the old replica archives and closes, e.g. when a
    // restored Page moves from its reader replica to the writer replica.
    return host.reloadAccess(previous, { install, onError: showError });
  }
  function downloadDraft(record) {
    const draft = host.current?.exportRecovery(record);
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.page_id}-local-draft.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function open(id, { focus = false, historyMode = "push" } = {}) {
    if (historyMode !== "none") writePageRoute(id, { replace: historyMode === "replace" });
    setPickerOpen(false);
    setNotice("");
    if (host.current?.pageId === id) return;
    const controller = new AbortController();
    const revision = host.navigate(controller);
    setError("");
    setOpening(true);
    releaseCurrent();
    try {
      // A quick Back may revisit a replica whose final local checkpoint is
      // still flushing. Wait only for that same Page, never an unrelated one.
      const principal = authentication.current?.identity?.principal;
      await host.closingFor(principal, id);
      if (!host.isCurrent(revision)) return;
      const loaded = await editor.readyWhile(() => navigationCurrent(revision, principal));
      if (!loaded) return;
      const { PageSession } = loaded;
      const next = await openPageWithRetry(
        () =>
          PageSession.open(id, {
            authentication: authentication.current,
            refreshSession: () => auth.current.refresh(),
          }),
        { signal: controller.signal },
      );
      await install(next, revision, { focus });
    } catch (error) {
      if (host.isCurrent(revision) && !bannerShows(error)) showError(error);
    } finally {
      host.finishRequest(controller);
      if (host.isCurrent(revision)) setOpening(false);
    }
  }
  function home(event, { historyMode = "push", refreshCatalog = true } = {}) {
    if (event) {
      if (!isPlainNavigation(event)) return;
      event.preventDefault();
    }
    host.navigate();
    releaseCurrent();
    setAccount(authentication.current?.identity ?? null);
    setError("");
    setNotice("");
    setOpening(false);
    setPickerOpen(false);
    setTrashOpen(false);
    setProjectOpen(null);
    setIndex(null);
    if (historyMode !== "none") writePageRoute(null, { replace: historyMode === "replace" });
    if (refreshCatalog) void refresh().catch((error) => showError(error));
  }
  function openProject(projectId, { historyMode = "push" } = {}) {
    home(null, { historyMode: "none", refreshCatalog: false });
    if (historyMode !== "none") writePageRoute(projectId, { replace: historyMode === "replace" });
    setProjectOpen(projectId);
  }
  /** Show an index route (readPageRoute's `projects` or `pages`). */
  function openIndex(route, { historyMode = "push" } = {}) {
    home(null, { historyMode: "none", refreshCatalog: false });
    if (historyMode !== "none") writeRoute(route.path, { replace: historyMode === "replace" });
    setIndex({
      kind: route.kind,
      query: route.query ?? "",
      visit: ++indexVisits.current,
      principal: authentication.current?.identity?.principal ?? null,
    });
  }
  /** The Home · All Pages · Projects nav and the switcher's index links. */
  function navigateIndex(kind) {
    if (kind === "home") home(null);
    else openIndex(readPageRoute(kind === "projects" ? PROJECTS_PATH : pagesPath()));
  }
  /** Whether index visit `visit` is still on screen for the account that
   * started it, at its own address. */
  const indexCurrent = (visit, principal) =>
    indexVisits.current === visit &&
    authentication.current?.identity?.principal === principal &&
    isIndexRoute(readPageRoute(location.href));
  /** A listing failure goes to the screen's banner like any failed action,
   * while its screen is still the one showing. */
  const reportListing = (visit, principal) => (message) => {
    if (indexCurrent(visit, principal)) setError(message);
  };
  /** A search typed on /pages: the address and the visit's query follow it,
   * so Back, a reload, or a remount after a failed Page open show it again.
   * A visit whose address moved on (to the Page it is opening) leaves the
   * address alone. */
  const followIndexQuery = (visit, principal) => (query) => {
    if (!indexCurrent(visit, principal) || readPageRoute(location.href).kind !== "pages") return;
    setIndex((current) => (current?.visit === visit ? { ...current, query } : current));
    writeRoute(pagesPath(query), { replace: true });
  };
  const retryListing = (retry) => {
    setError("");
    retry();
  };
  function showTrash() {
    home(null, { refreshCatalog: false });
    setTrashOpen(true);
  }
  async function reopen(id, { restore = false } = {}) {
    // Access changed on the host; open a fresh session for the current grant.
    host.navigate();
    releaseCurrent({ restore });
    await open(id, { historyMode: "none" });
  }
  async function restoreCurrent() {
    const restoring = host.current;
    if (!restoring) return;
    try {
      await restorePage(tool, restoring.pageId, restoring.identity.principal);
      await reopen(restoring.pageId, { restore: true });
      setNotice("Page restored");
      void refresh().catch(() => {});
    } catch (error) {
      showError(error);
    }
  }
  function followRoute() {
    const route = readPageRoute(location.href);
    if (route.kind === "page") void open(route.pageId, { historyMode: "replace" });
    // Replace keeps the address canonical when an older /s/ link opened it.
    else if (route.kind === "project") openProject(route.projectId, { historyMode: "replace" });
    // Replace drops a trailing slash or an empty search from the address.
    else if (isIndexRoute(route)) openIndex(route, { historyMode: "replace" });
    else if (route.kind === "home") home(null, { historyMode: "none", refreshCatalog: false });
    else {
      host.navigate();
      releaseCurrent();
      setOpening(false);
      setError("This Page link is not valid.");
    }
    void refresh().catch((error) => {
      if (!host.current) showError(error);
    });
  }
  // Publish the visual viewport's edges for the mobile bar and header.
  useEffect(() => trackVisualViewport(), []);
  // On phones the status is a dot (its label stays for screen readers), and
  // Share, activity and the page actions sit under one ⋯ menu.
  const [phoneHeader, setPhoneHeader] = useState(() => matchMedia(MOBILE_EDITOR_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(MOBILE_EDITOR_QUERY);
    const change = () => setPhoneHeader(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    let alive = true;
    const maintenance = maintainBrowserSession({
      // The first refresh takes the request theme.js started (early-session.mjs).
      request: () => requestSession(request),
      onSession: (result, { refusal }) => {
        if (!alive) return;
        // A refusal keeps the sign-out below and says why it happened.
        setSessionNotice(
          sessionAnswerNotice(refusal, { signedIn: !!authentication.current?.identity }),
        );
        const changed = authentication.current?.identity?.principal !== result.identity?.principal;
        if (changed) {
          host.navigate();
          catalogRevision.current++;
          setPages([]);
          setOpening(false);
        }
        authentication.current = result;
        const live = host.current;
        if (!live) {
          setAccount(result.identity);
          if (changed && result.identity) followRoute();
        } else {
          const resume = live.authRequired;
          if (live.acceptAuthentication(result)) {
            setAccount(result.identity);
            if (resume) void live.retryConnection();
          }
        }
      },
      onError: (error, { outage }) => {
        if (!alive) return;
        const banner = sessionCheckBanner(error, {
          outage,
          signedIn: !!authentication.current?.identity,
        });
        if (banner !== undefined) setSessionNotice({ message: banner, signIn: false });
        setAccount((value) => (value === undefined ? null : value));
      },
    });
    auth.current = maintenance;
    const onPopState = () => {
      if (authentication.current?.identity) followRoute();
      else home(null, { historyMode: "none", refreshCatalog: false });
    };
    window.addEventListener("popstate", onPopState);
    // The first answer reaches onSession or onError like every later one,
    // which decide what to show; a refusal of a tab that was never signed in
    // shows the signed-out landing and nothing else.
    maintenance.refresh().catch(() => {});
    return () => {
      alive = false;
      maintenance.stop();
      window.removeEventListener("popstate", onPopState);
      catalogRevision.current++;
      host.navigate();
      void host.close(host.current);
    };
  }, []);
  const page = session?.snapshot(),
    threads = page?.comments ?? [];
  // The screen's one banner region (screenBanners). The sign-in prompt and
  // access notice beside the Page show their own messages with their actions.
  const banners = screenBanners({ error, sessionNotice, page: page ? session : null });
  useEffect(() => {
    if (!titleFocusRequest) return;
    const frame = requestAnimationFrame(() => {
      focusCreatedPageTitle(titleInput.current, titleFocusRequest, host.current);
      setTitleFocusRequest((request) => (request === titleFocusRequest ? null : request));
    });
    return () => cancelAnimationFrame(frame);
  }, [titleFocusRequest, session]);
  useEffect(() => {
    if (!focusBlock || !session?.canWrite) return;
    const frame = requestAnimationFrame(() => {
      if (host.current !== session || !session.canWrite) return;
      const element = article.current?.querySelector(
        `[data-block-id="${CSS.escape(focusBlock)}"] wg-content`,
      );
      if (element) {
        element.focus();
        element.scrollIntoView({ block: "nearest" });
        setFocusBlock(null);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusBlock, session, page?.blocks.length]);
  async function create() {
    if (creationPending.current || host.current?.authRequired) return;
    creationPending.current = true;
    setCreating(true);
    setError("");
    setPickerError("");
    const revision = host.navigate();
    const principal = authentication.current?.identity?.principal;
    try {
      // Creating persists a draft. A navigation or account change while the
      // editor downloads cancels it before anything is written.
      const loaded = await editor.readyWhile(() => navigationCurrent(revision, principal));
      if (!loaded) return;
      const { PageSession } = loaded;
      const next = await PageSession.create(
        { title: "Untitled" },
        {
          authentication: authentication.current,
          refreshSession: () => auth.current.refresh(),
        },
      );
      if (!host.isCurrent(revision)) {
        await next.close();
        return;
      }
      releaseCurrent();
      writePageRoute(next.pageId);
      setPickerOpen(false);
      setOpening(false);
      setNotice("");
      if (await install(next, revision)) setTitleFocusRequest(next);
      void refresh().catch(() => {});
    } catch (error) {
      if (host.isCurrent(revision) && !bannerShows(error)) {
        showError(error);
        setPickerError(failureMessage(error));
      }
    } finally {
      creationPending.current = false;
      setCreating(false);
    }
  }
  async function copyLink(pageId = host.current?.pageId) {
    if (!pageId) return;
    try {
      await navigator.clipboard.writeText(new URL(pagePath(pageId), location.origin).href);
      setNotice("Link copied");
      if (documentDisclosure.current) documentDisclosure.current.open = false;
    } catch {
      setError(
        pageId === host.current?.pageId
          ? "Couldn't copy the link. You can copy it from the address bar."
          : "Couldn't copy the link. Open the page and copy its address.",
      );
    }
  }
  async function remove() {
    const deleting = host.current;
    if (!deleting) return;
    if (
      deleting.authRequired ||
      deleting.identity.principal !== authentication.current?.identity?.principal
    ) {
      setError("Sign in with this Page's original account to move it to Trash.");
      return;
    }
    if (
      !confirm(
        "Move this Page to Trash? Collaborators lose access until you restore it from Trash.",
      )
    )
      return;
    try {
      const prepared = await tool("list_pages");
      if (deleting.identity.principal !== authentication.current?.identity?.principal)
        throw Error("Sign in with this Page's original account to move it to Trash.");
      const trashed = await tool("delete_page", {
        page_id: deleting.pageId,
        expected_principal: deleting.identity.principal,
        retry_token: prepared.retry_token,
        base_heads: editor.module.pageHeads(deleting.doc),
        idempotency_key: await retryKey(prepared.retry_token),
      });
      if (trashed?.superseded)
        throw Error("This Page changed before it could move to Trash. Try again.");
      const activeDeletion = host.current?.pageId === deleting.pageId ? host.current : null;
      if (activeDeletion || readPageRoute(location.href).pageId === deleting.pageId) {
        host.navigate();
        host.detach();
        resetDocumentUI();
        setOpening(false);
        writePageRoute(null, { replace: true });
      }
      // Leave through the host so Reload waits for the checkpoint and a
      // failed one keeps its recovery export.
      const closing = closeTrashedSessions(host, [deleting, activeDeletion], {
        onError: showError,
      });
      // Keep the local replica: the Page can be restored from Trash. A draft
      // the host never registered has no Trash entry, so discard it instead of
      // leaving it listed as saved locally.
      if (!deleting.localPage?.registered) {
        await closing;
        await forgetLocalPage(deleting.identity, deleting.pageId);
      }
      setNotice("Moved to Trash");
      await refresh();
    } catch (error) {
      showError(error);
    }
  }
  async function signout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
      let failed;
      await host.close(host.current, { onError: (error) => (failed = error) });
      if (failed) throw failed;
      location.href = "/";
    } catch (error) {
      showError(error);
    }
  }
  // Comment on a selection opens the inline composer beside it. Readers
  // without write access get the thread list instead.
  function startComment(id, selected) {
    if (!session || !id || !selected) return;
    activateBlock(id);
    if (!session.canWrite) {
      setCommentsOpen(true);
      return;
    }
    try {
      const draft = editor.module.captureCommentDraft(session.doc, id, selected);
      if (composer.start(draft, selected.text.replaceAll("\ufffc", "\n"))) setTarget(null);
    } catch (error) {
      showError(error);
    }
  }
  // A new thread's passage shows briefly, then returns to its resting style.
  useEffect(() => {
    if (target?.source !== "created") return;
    const subscription = timer(CREATED_FLASH_MS).subscribe(() =>
      setTarget((current) => (current === target ? null : current)),
    );
    return () => subscription.unsubscribe();
  }, [target]);
  function closeComments() {
    setCommentsOpen(false);
    requestAnimationFrame(() => commentsButton.current?.focus({ preventScroll: true }));
  }
  function toggleComments() {
    if (commentsOpen) closeComments();
    else setCommentsOpen(true);
  }
  function selectComment(id) {
    setTarget({ id, request: performance.now(), source: "passage" });
    setCommentsOpen(true);
  }
  function revealComment(thread) {
    setTarget({ id: thread.id, request: performance.now(), source: "quote" });
    const id =
      thread.target.kind === "selection" ? thread.target.anchor.blockId : thread.target.blockId;
    if (thread.target.kind === "block" || thread.selectionContext?.status === "detached")
      article.current
        ?.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
  }
  function continueWriting() {
    if (!session || host.current !== session) return;
    try {
      const id = editor.module.writingContinuation(session);
      if (!id || host.current !== session) return;
      activateBlock(id);
      setFocusBlock(id);
    } catch (error) {
      showError(error);
    }
  }
  function revealProgress(passage) {
    const marker = `[data-progress-id="${CSS.escape(passage.progress.progress_id)}"][data-progress-target="${passage.index}"]`;
    const element =
      article.current?.querySelector(marker) ??
      article.current?.querySelector(`[data-block-id="${CSS.escape(passage.block_id)}"]`);
    element?.scrollIntoView({ block: "center", inline: "nearest" });
  }
  useEffect(() => {
    document.title = page
      ? `${page.title || "Untitled"} · Pages`
      : index && !projectOpen && !trashOpen && !opening
        ? `${index.kind === "pages" ? "All Pages" : "Projects"} · Pages`
        : "Pages · nteract";
  }, [page?.title, index, projectOpen, trashOpen, opening]);
  const listedPages = pages.map((item) =>
    item.page_id === page?.page_id ? { ...item, title: page.title } : item,
  );
  const libraryPages = matchingPages(listedPages, libraryQuery);
  const openComments = threads.filter((thread) => thread.state === "open").length;
  // The page menu: Document actions on desktop, the ⋯ menu on phones.
  const pageActions = session
    ? [
        session.canWrite && {
          key: "formatting",
          label: toolbarOpen ? "Hide formatting" : "Show formatting",
          icon: Type,
          kbd: "Alt F10",
          attributes: {
            "aria-expanded": toolbarOpen,
            "aria-controls": "page-formatting",
            "aria-keyshortcuts": "Alt+F10",
          },
          run: () => {
            showFormatting(!toolbarOpen, !toolbarOpen);
            if (toolbarOpen) documentDisclosure.current?.querySelector("summary")?.focus();
          },
        },
        { key: "copy-link", label: "Copy link", icon: Link, run: () => copyLink() },
        localRecoveries.length > 0 && {
          key: "local-draft",
          label: "Download previous local draft",
          run: () => downloadDraft(localRecoveries.at(-1)),
        },
        session.canRestore && {
          key: "restore",
          label: "Restore from Trash",
          icon: RotateCcw,
          run: restoreCurrent,
        },
        session.canDelete && {
          key: "trash",
          label: "Move to Trash",
          icon: Trash2,
          danger: true,
          run: remove,
        },
      ].filter(Boolean)
    : [];
  return (
    <div className={page ? "app has-document" : "app"} onKeyDownCapture={formattingShortcut}>
      <header className="app-header">
        <div className="header-navigation">
          <a href="/" className="brand" onClick={account ? home : undefined}>
            Pages
          </a>
          {account && (
            <button
              className={`subtle-button pages-trigger${page ? " document-switcher" : ""}`}
              aria-label={`${page?.title || (page ? "Untitled" : "Browse")}, switch page`}
              title="Switch page"
              onClick={() => {
                setPickerError("");
                setPickerOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
            >
              {!page && <FolderOpen size={18} aria-hidden="true" />}
              {!page && <span>Browse</span>}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="header-actions">
          {page && (
            <div className="document-meta">
              <div className="document-status">
                <SaveStatus
                  status={session.status}
                  statusKey={session.statusKey}
                  compact={phoneHeader}
                />
                {session.statusRetry && (
                  <button
                    className="subtle-button"
                    onClick={() => session.retryConnection({ retryReceipt: true })}
                  >
                    Retry
                  </button>
                )}
              </div>
              <div className="document-controls">
                <PageControls
                  phone={phoneHeader}
                  session={session}
                  actions={pageActions}
                  onReveal={revealProgress}
                  activityDisclosure={activityDisclosure}
                  actionsDisclosure={documentDisclosure}
                >
                  <button
                    ref={commentsButton}
                    className="subtle-button comments-toggle"
                    aria-label="Comments"
                    aria-describedby="open-comment-count"
                    aria-expanded={commentsOpen}
                    aria-controls="page-comments"
                    onClick={toggleComments}
                  >
                    <MessageSquare size={18} aria-hidden="true" />
                    <span>Comments</span>
                    <span id="open-comment-count" className="sr-only">
                      {openComments} open {openComments === 1 ? "comment" : "comments"}
                    </span>
                    {openComments > 0 && <span className="comment-count">{openComments}</span>}
                  </button>
                </PageControls>
              </div>
            </div>
          )}
          {account && (
            <details className="account-actions" ref={accountDisclosure}>
              <summary
                className="icon-button"
                aria-label="Account"
                title={account.displayName || "Account"}
              >
                <UserRound size={19} aria-hidden="true" />
              </summary>
              <div className="menu-popover">
                <p className="account-name">{account.displayName || "Your workspace"}</p>
                <AppearanceControls />
                <a
                  href="/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    accountDisclosure.current.open = false;
                  }}
                >
                  <Plug size={16} aria-hidden="true" /> Connect an agent
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <button onClick={signout}>
                  <LogOut size={16} aria-hidden="true" /> Sign out
                </button>
              </div>
            </details>
          )}
        </div>
      </header>
      {page && <div id="page-formatting" className="toolbar-host" ref={setToolbar} />}
      <BuildUpdate
        session={session}
        principal={authentication.current?.identity?.principal}
        onOpenPage={(id) => void open(id)}
        editorUnavailable={editorUnavailable && !!account}
      />
      {banners.map((message) => (
        <p key={message} role="alert" className="error app-error">
          {message}
        </p>
      ))}
      {notice && (
        <p className="app-notice" role="status">
          {notice}
        </p>
      )}
      {account === undefined ? (
        <main className="welcome">
          <p role="status">Connecting…</p>
        </main>
      ) : !account ? (
        <main className="welcome">
          <h1>A place to write together.</h1>
          <a
            className="primary"
            href={`/api/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
          >
            Sign In
          </a>
        </main>
      ) : (
        <>
          <PagePicker
            open={pickerOpen}
            pages={listedPages}
            currentId={page?.page_id}
            onClose={() => setPickerOpen(false)}
            onOpen={open}
            onCreate={create}
            onTrash={showTrash}
            onOpenIndex={navigateIndex}
            projects={projects}
            currentProjectId={projectOpen}
            onOpenProject={(id) => openProject(id)}
            creating={creating || !!session?.authRequired}
            error={pickerError}
          />
          {page ? (
            <main
              className={commentsOpen ? "workspace document with-comments" : "workspace document"}
            >
              <article ref={article}>
                <h1 className="document-print-title sr-only">{page.title || "Untitled"}</h1>
                <Breadcrumbs
                  crumbs={crumbs}
                  onOpenProject={(id) => openProject(id)}
                  onOpenPage={open}
                />
                {session.authRequired && (
                  <p className="error" role="alert">
                    {session.authProblem}{" "}
                    <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
                      Sign in
                    </a>{" "}
                    <button onClick={() => session.retryConnection({ retryReceipt: true })}>
                      Retry connection
                    </button>
                  </p>
                )}
                {session.accessProblem && (
                  <div className="access-notice" role="status">
                    <p>{session.accessProblem}</p>
                    <button onClick={() => downloadDraft()}>Download local draft</button>
                    {session.accessReloadRequired && (
                      <button onClick={() => reloadAccess()}>Reload current Page</button>
                    )}
                  </div>
                )}
                {session.trash && (
                  <div className="access-notice trash-notice" role="status">
                    <p>This Page is in Trash. It is read-only and hidden from collaborators.</p>
                    {session.canRestore && <button onClick={restoreCurrent}>Restore</button>}
                    <button onClick={showTrash}>Open Trash</button>
                  </div>
                )}
                {/* Edits the host refuses can only wait in this browser's checkpoint;
                    the notice's Reload accepts that. */}
                <SchemaNotice
                  gate={session.schemaGate}
                  reload={() => reloadGate.reload({ acceptCheckpoints: true })}
                />
                <input
                  ref={titleInput}
                  className="document-title"
                  aria-label="Page title"
                  title={page.title || "Untitled"}
                  placeholder="Untitled"
                  value={page.title}
                  readOnly={!session.canWrite}
                  onChange={(event) => {
                    try {
                      session.change((doc) => editor.module.setPageTitle(doc, event.target.value));
                    } catch (error) {
                      showError(error);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!titleHandsOffToBody(event, session.canWrite)) return;
                    event.preventDefault();
                    const first = editor.module.orderedBlockIds(session.doc)[0];
                    if (first) {
                      activateBlock(first);
                      setFocusBlock(first);
                    } else continueWriting();
                  }}
                />
                {page.blocks.map((block) => (
                  <section className="page-block" data-block-id={block.id} key={block.id}>
                    {block.format === "automerge-rich-text-v1" ? (
                      <WordgardEditor
                        replica={session}
                        id={block.id}
                        editable={session.canWrite}
                        onError={setError}
                        onComment={(selected) => startComment(block.id, selected)}
                        onRevealComment={selectComment}
                        openComments={openComments}
                        onOpenComments={toggleComments}
                        toolbarHost={active === block.id ? toolbar : null}
                        toolbarOpen={toolbarOpen}
                        onActivate={() => activateBlock(block.id)}
                        threads={threads}
                        commentTarget={target}
                        commentDraft={
                          composerState.composer?.draft.blockId === block.id &&
                          (composerState.state.name === "open" ||
                            composerState.state.name === "sending")
                            ? composerState.composer.draft
                            : null
                        }
                      />
                    ) : (
                      <pre>{block.markdown ?? "Unsupported block"}</pre>
                    )}
                  </section>
                ))}
                {session.canWrite && (
                  <button type="button" className="writing-continuation" onClick={continueWriting}>
                    Write something…
                  </button>
                )}
              </article>
              <CommentsPanel
                key={session.pageId}
                open={commentsOpen}
                session={session}
                threads={threads}
                composer={composer}
                target={target}
                onClose={closeComments}
                onReveal={revealComment}
                onSelect={selectComment}
              />
              <CommentPopover
                key={`popover-${session.pageId}`}
                composer={composer}
                session={session}
                containerRef={article}
              />
            </main>
          ) : opening ? (
            <main className="welcome">
              <p role="status">Opening…</p>
            </main>
          ) : projectOpen ? (
            <ProjectView
              key={projectOpen}
              tool={tool}
              projectId={projectOpen}
              onOpen={(id) => open(id)}
              onBack={() => navigateIndex("projects")}
              onCreated={() => void refresh().catch(() => {})}
            />
          ) : index?.kind === "projects" ? (
            <ProjectsIndex
              key={index.visit}
              tool={tool}
              onNavigate={navigateIndex}
              onOpenProject={(id) => openProject(id)}
              onError={reportListing(index.visit, index.principal)}
              onRetry={retryListing}
            />
          ) : index?.kind === "pages" ? (
            <PagesIndex
              key={index.visit}
              tool={tool}
              query={index.query}
              projects={projects}
              onNavigate={navigateIndex}
              onQueryChange={followIndexQuery(index.visit, index.principal)}
              onOpen={(id) => open(id)}
              onOpenProject={(id) => openProject(id)}
              onWarm={warmEditor}
              onError={reportListing(index.visit, index.principal)}
              onRetry={retryListing}
            />
          ) : trashOpen ? (
            <TrashView
              tool={tool}
              principal={account.principal}
              onBack={() => home(null)}
              onOpen={(id) => open(id)}
              onRestored={async () => {
                setNotice("Page restored");
                await refresh().catch(() => {});
              }}
              onPurged={async (id) => {
                await forgetLocalPage(authentication.current?.identity, id);
                setNotice("Page deleted permanently");
                await refresh().catch(() => {});
              }}
            />
          ) : (
            <main className="page-library">
              <IndexNav current="home" onNavigate={navigateIndex} />
              <div className="library-heading">
                <h1>Your pages</h1>
                <div className="library-actions">
                  <button className="subtle-button" onClick={showTrash}>
                    <Trash2 size={16} aria-hidden="true" /> Trash
                  </button>
                  <button className="primary" onClick={create} disabled={creating}>
                    <Plus size={18} aria-hidden="true" /> New Page
                  </button>
                </div>
              </div>
              <label className="picker-search library-search">
                <Search size={18} aria-hidden="true" />
                <input
                  aria-label="Search your pages"
                  placeholder="Search pages"
                  value={libraryQuery}
                  onChange={(event) => setLibraryQuery(event.target.value)}
                  type="search"
                />
              </label>
              {!pages.length && <p className="muted">Start a page and write together.</p>}
              {!!pages.length && !libraryPages.length && (
                <p className="muted">No matching pages.</p>
              )}
              <ul className="page-list page-cards" aria-label="Your pages">
                {libraryPages.map((item) => (
                  <li className="page-row" key={item.page_id}>
                    <a
                      className="page-card"
                      href={pagePath(item.page_id)}
                      onClick={(event) => {
                        if (isPlainNavigation(event)) {
                          event.preventDefault();
                          void open(item.page_id);
                        }
                      }}
                    >
                      <FileText size={19} aria-hidden="true" />
                      <span className="page-card-title">{item.title || "Untitled"}</span>
                      {item.pending && <span className="page-card-meta">Saved locally</span>}
                    </a>
                    <button
                      className="icon-button page-row-action"
                      aria-label={`Copy link to ${item.title || "Untitled"}`}
                      title="Copy link"
                      onClick={() => copyLink(item.page_id)}
                    >
                      <Link size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </main>
          )}
        </>
      )}
    </div>
  );
}

function useDismissibleDisclosure() {
  const disclosure = useRef(null);
  useEffect(() => {
    const dismissOutside = (event) => {
      const element = disclosure.current;
      if (element?.open && !element.contains(event.target)) element.open = false;
    };
    const dismissEscape = (event) => {
      const element = disclosure.current;
      if (event.key !== "Escape" || !element?.open) return;
      event.preventDefault();
      element.open = false;
      element.querySelector("summary")?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, []);
  return disclosure;
}

createRoot(document.getElementById("root")).render(<App />);
