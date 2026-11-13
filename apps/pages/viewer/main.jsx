import "../../../src/styles/notebook-tokens.css";
import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  FilePlus,
  FolderInput,
  FolderOpen,
  LogOut,
  Link,
  MessageSquare,
  Plug,
  RotateCcw,
  Type,
  Trash2,
  UserRound,
  Unplug,
} from "lucide-react";
import { observeSignedOut, request, tool } from "./request.mjs";
import {
  failureMessage,
  screenBanners,
  sessionAnswerNotice,
  sessionCheckBanner,
} from "./alerts.mjs";
import { listLocalPages, retireLocalPage } from "./local-catalog.mjs";
import { recoveryDownloadAction } from "./recovery-capture.mjs";
import {
  LIBRARY_DEFAULTS,
  PROJECTS_PATH,
  isIndexRoute,
  isLibraryRoute,
  libraryBase,
  libraryPath,
  pagePath,
  projectPath,
  readPageRoute,
  writePageRoute,
  writeRoute,
  isPlainNavigation,
  mergePageListings,
} from "../shared/routes.mjs";
import { PRODUCT_NAME, tabTitle } from "../shared/product.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { earlyConnectAnswer, requestSession } from "./early-session.mjs";
import { PagePreview } from "./PagePreview.jsx";
import { PageBlocks, ScreenBoundary } from "./BlockBoundary.jsx";
import { BootPreview, visiblePreview } from "./boot-preview.mjs";
import { HeadingScroll } from "./heading-scroll.mjs";
import { openPageWithRetry } from "./page-open.mjs";
// app.css carries the editor's styles too, ahead of style.css so the cascade
// matches the editor modules' own import order.
import "./link-popover.css";
import "./wordgard.css";
import "./sharing-panel.css";
import "./comments.css";
import "./save-status.css";
import { PagePicker } from "./PagePicker.jsx";
import { ProjectCreator } from "./ProjectCreator.jsx";
import { MoveDialog } from "./MoveDialog.jsx";
import { ConnectedAgents } from "./ConnectedAgents.jsx";
import { moveOrigin } from "./container-dialog-machine.mjs";
import { TrashView } from "./TrashView.jsx";
import { Breadcrumbs, ProjectChip, ProjectPages } from "./ProjectView.jsx";
import { pageCreations } from "./page-create-machine.mjs";
import { ProjectsIndex } from "./IndexViews.jsx";
import { Library } from "./Library.jsx";
import { listProjectPages, pageLocation, watchPageLocation } from "./projects.mjs";
import { closeTrashedSessions, moveToTrashError, restorePage } from "./trash.mjs";
import { listAllPages } from "./page-list.mjs";
import { listingCache } from "./listing-cache.mjs";
import { PageRefs } from "./page-refs.mjs";
import { provideChitRefs } from "./chit-refs.mjs";
import { PageLinkCard } from "./PageLinkCard.jsx";
import { CurrentPage, CurrentProject } from "./current-page.mjs";
import { PickerWalk } from "./picker-walk.mjs";
import { SignedOutRecovery } from "./signed-out-recovery.mjs";
import { ProjectList } from "./project-list.mjs";
import { quotaNotice } from "./quota.mjs";
import { AppearanceControls } from "./AppearanceControls.jsx";
import "./style.css";
import "./formatting-toolbar.css";
import "./card-image.css";
import { focusCreatedPageTitle, titleHandsOffToBody } from "./title-navigation.mjs";
import { BuildUpdate, buildMonitor } from "./BuildUpdate.jsx";
import { SchemaNotice } from "./SchemaNotice.jsx";
import { RetiredPage } from "./RetiredPage.jsx";
import { UnopenedPage } from "./UnopenedPage.jsx";
import { formatRefused, sessionFormatStopped, trashArguments } from "./unopened-page.mjs";
import { reloadGate } from "./build-freshness.mjs";
import { EditorLoader } from "./editor-loader.mjs";
import { SessionHost } from "./session-host.mjs";
import { useStore } from "./store.mjs";
import { CommentComposer, draftRecord, hasDraftText } from "./comment-composer.mjs";
import { focusReturnTarget } from "./focus-return.mjs";
import { timer } from "rxjs";
import { MOBILE_EDITOR_QUERY, trackVisualViewport } from "./visual-viewport.mjs";
import { glideSettings, gridRequested, marginRequested } from "./feature-flags.mjs";
import { MarginThreads } from "./MarginThreads.jsx";
import { writeDisplayMode } from "./display-mode.mjs";

// Opening a Page rewrites the address to its canonical path, and the library
// rewrites its own, both dropping the query, so read the opening settings
// before anything routes. `?grid=1` asks for the grid, so it becomes the
// remembered display that every library this tab mounts opens on.
glideSettings();
marginRequested();
if (gridRequested()) writeDisplayMode(globalThis.window, "grid");

// The editor, and the WASM runtimes it waits for, load beside the shell
// from boot, except on the index routes (/projects, /pages), which only list;
// there the first Page open or creation starts it. Home (/) shows the same
// library as /pages but starts the editor at boot, since a Page usually opens
// next. A Page session exists only
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
// The routed Page's read-only preview from the head script's discovery
// (boot-preview.mjs). Read at boot, before a session can take that request.
// The shell reports the session, navigation, failed opens and the live Page
// to it; once retired it stays retired for this load.
const bootPreview = new BootPreview();
{
  const route = readPageRoute(location.href);
  if (route.kind === "page") bootPreview.start(route.pageId, earlyConnectAnswer(route.pageId));
}
// The scroll to the address's heading, and Back and Forward's scroll
// positions (heading-scroll.mjs). It starts at boot so that the reader
// scrolling the loading preview calls the heading's scroll off.
const headingScroll = new HeadingScroll();
headingScroll.start();
headingScroll.requestFromAddress();
// A pointer going down on a Page row is a strong hint a Page opens next.
const warmEditor = () => editor.start();
// What the App does with an answer for another account than the tab's
// (another window signed in): the library's list_pages, the Browse picker's
// walk and list_projects all report here, and the session's recovery
// (signed-out-recovery.mjs) rechecks who is signed in, bounded like a 401's.
// `generation` is that recovery's session check generation. Set while the
// App is mounted.
const accountHooks = { otherAccount: () => {}, generation: () => 0 };
// The account's Projects, one list_projects request shared by the library's
// Project filter, the Browse picker, Move to… and /projects.
const projectList = new ProjectList({
  call: tool,
  onOtherAccount: () => accountHooks.otherAccount(),
});
// The App's handler for the Browse picker's error line, set while it is
// mounted.
const pickerHooks = { report: () => {} };
// The Browse picker (picker-walk.mjs): open or closed, and the walk of every
// Page the account can open while it is open. It starts from the library's
// first page when this tab showed it within the cache's age limit (read
// only: the walk is not a library view). Closing it aborts the request in
// flight, so a cancelled walk's 401 never starts a recovery.
const picker = new PickerWalk({
  walk: ({ signal }) => listAllPages(tool, { signal }),
  seed: (principal) => listingCache.read(principal, LIBRARY_DEFAULTS),
  report: (message) => pickerHooks.report(message),
  onOtherAccount: () => accountHooks.otherAccount(),
  generation: () => accountHooks.generation(),
});
// What links to other Pages show this tab's reader (page-refs.mjs): titles
// and cards read with this tab's session, in memory only. Forgotten with the
// account, like the listing cache.
const pageRefs = new PageRefs();
provideChitRefs(pageRefs);
/** Forget the rows and Projects remembered for the account: it signed out or
 * another one signed in. The Browse picker closes and drops its walk; nothing
 * here starts a request. */
function forgetAccountData() {
  listingCache.clear();
  projectList.reset();
  picker.forget();
  pageRefs.clear(null);
}
/** The same, for a tool call the server refused as signed out, before the
 * session check says who is signed in. The Browse picker drops its rows but
 * stays open to say why; the check's answer closes it through
 * forgetAccountData if the account changed or signed out. Nothing here starts
 * a request, so a 401 handled here can't cause another. */
function forgetRefusedAccountData() {
  listingCache.clear();
  projectList.reset();
  picker.refused();
  pageRefs.clear();
}
const NO_PROJECTS = Object.freeze([]);
// How long a new thread's passage stays emphasized after the inline composer
// sends it.
const CREATED_FLASH_MS = 1600;
// The sessions this tab owns. The reload gate follows them from here.
const host = new SessionHost();
reloadGate.watch(host);
const installedSession = (state) => state.current;
function projectDetailsTransition(state, event) {
  if (event.type === "reset") return { name: event.value ? "ready" : "idle", value: event.value };
  if (event.type === "load" && ["idle", "failed"].includes(state.name))
    return { name: "loading", projectId: event.projectId, value: null };
  if (state.name === "loading" && event.type === "loaded")
    return { name: "ready", value: event.value };
  if (state.name === "loading" && event.type === "failed")
    return { name: "failed", projectId: state.projectId, value: null, error: event.error };
  return state;
}
const editorFailed = (state) => state.name === "failed";
// The build banner already asks for a reload when the editor can't load.
const bannerShows = (error) => error?.code === "EDITOR_UNAVAILABLE";

function App() {
  const accountDisclosure = useDismissibleDisclosure(),
    documentDisclosure = useDismissibleDisclosure(),
    activityDisclosure = useDismissibleDisclosure();
  const [account, setAccount] = useState(undefined),
    [, paint] = useState(0),
    [error, setError] = useState(""),
    // The session check's banner: { message, signIn } or null.
    [sessionNotice, setSessionNotice] = useState(null),
    [notice, setNotice] = useState(""),
    // This browser's local catalog for the account (local-catalog.mjs), as
    // the last refresh read it. The library and the picker show its drafts.
    [localPages, setLocalPages] = useState([]),
    [trashOpen, setTrashOpen] = useState(false),
    // A Page the host refused to open for its document format, with no
    // session: { pageId, principal } for its stopped screen, or null.
    [unopened, setUnopened] = useState(null),
    // list_pages' `quota` for the signed-in account, from the library's
    // latest answer, or null.
    [quota, setQuota] = useState(null),
    [projectOpen, setProjectOpen] = useState(null),
    // A listing screen: { kind: "projects" | "pages" | "home", library, visit,
    // principal } or null. "home" and "pages" are the Pages library at / and
    // /pages. `visit` remounts the listing for each navigation to it; Back
    // and Forward from one library address to another keep it, and the
    // mounted library takes the new `library` (normalizeLibraryView), which
    // also follows the view chosen there. Null shows the library at the
    // address's view.
    [index, setIndex] = useState(null),
    // read_page's location for the open Page, null until it answers.
    [placement, setPlacement] = useState(null),
    [projectDetails, dispatchProjectDetails] = useReducer(projectDetailsTransition, {
      name: "idle",
      value: null,
    }),
    // The open Project's Pages: { pageId, pages },
    // or null until list_pages answers.
    [projectPages, setProjectPages] = useState(null),
    // The New Project or Move to… dialog: null, { kind: "create" } or
    // { kind: "move", pageId, title, projectId }. Each runs its own machine.
    [containerDialog, setContainerDialog] = useState(null),
    // The Connected agents dialog, opened from the account menu.
    [agentsOpen, setAgentsOpen] = useState(false),
    // The host advertised account controls but its list route answered 404,
    // as an older ingress does: the menu stops offering them.
    [agentsMissing, setAgentsMissing] = useState(false);
  const [toolbar, setToolbar] = useState(null),
    [toolbarOpen, setToolbarOpen] = useState(false),
    [active, setActive] = useState(null),
    [commentsOpen, setCommentsOpen] = useState(false),
    [target, setTarget] = useState(null),
    // The passage under the pointer, so the comments list can mark its row.
    [hoveredThread, setHoveredThread] = useState(null),
    [pickerError, setPickerError] = useState(""),
    [creating, setCreating] = useState(false),
    // One creation at a time, and placed creates to replay (page-create-machine.mjs).
    [creations] = useState(pageCreations),
    [opening, setOpening] = useState(false),
    [focusBlock, setFocusBlock] = useState(null),
    [titleFocusRequest, setTitleFocusRequest] = useState(null),
    [localRecoveries, setLocalRecoveries] = useState([]);
  const session = useStore(host.store, installedSession);
  const bootPreviewState = useStore(bootPreview.store);
  const editorUnavailable = useStore(editor.store, editorFailed);
  // The account's Projects, once list_projects answered for this account.
  const projectState = useStore(projectList.store);
  const projectsReady =
    !!account?.principal && projectState.principal === account.principal && projectState.ready;
  const projects = projectsReady ? projectState.projects : NO_PROJECTS;
  // The Browse picker: open while its machine is, for the signed-in account.
  const pickerSnapshot = useStore(picker.store);
  const pickerOpen = pickerSnapshot.state.name !== "closed";
  const pickerLoading =
    pickerSnapshot.state.name === "loading" || pickerSnapshot.state.name === "refreshing";
  const pickerFailed =
    pickerSnapshot.state.name === "failed" || pickerSnapshot.state.name === "checking";
  // Rendered only beside a session; handlers read editor.module when they run.
  const {
    WordgardEditor,
    CommentsPanel,
    CommentPopover,
    SaveStatus,
    PageControls,
    HeadingAnchors,
  } = editor.module ?? {};
  const auth = useRef(null),
    authentication = useRef(null),
    // Where the installed Page is (projects.mjs watchPageLocation), asked
    // until found; stopped when the Page is left or replaced.
    placementWatch = useRef(null),
    catalogRevision = useRef(0),
    indexVisits = useRef(0),
    // What this render shows, for handlers bound at mount (popstate).
    screen = useRef(null),
    article = useRef(null),
    titleInput = useRef(null),
    // The title value this tab last showed and its selection as native
    // cursors, so a peer's edit can put the caret back on its side.
    titleSelection = useRef(null),
    // The title input's composition state (title-selection.mjs). The ref is
    // read by event handlers; the state re-renders the value an IME shows.
    titleCompositionRef = useRef(null),
    activeBlock = useRef(null),
    commentsButton = useRef(null);
  screen.current = { index, projectOpen, trashOpen, opening, placement, unopened };
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
  /** Read this browser's local catalog (the drafts the library and picker
   * show) and the account's Projects. `fresh` asks list_projects again even
   * when a request is in flight, after a create or move this tab made. Page
   * listings belong to their screens: the library lists its own view, and
   * the picker walks every Page only while it is open. */
  const refresh = async ({ fresh = false } = {}) => {
    const identity = authentication.current?.identity;
    if (!identity) return;
    const revision = ++catalogRevision.current;
    // A failure leaves the Project filter empty and everything else usable.
    void projectList.request(identity.principal, { fresh }).catch(() => {});
    const closing = host.closingPages();
    const local = await listLocalPages(identity).catch(() => []);
    const stillCurrent = () =>
      identity.principal === authentication.current?.identity?.principal &&
      revision === catalogRevision.current;
    if (!stillCurrent()) return;
    setLocalPages(local);
    // A Page left by this navigation drains and writes its final local
    // checkpoint (title included) in the background. Read again once it lands.
    if (closing.length)
      void Promise.all(closing)
        .then(() => listLocalPages(identity))
        .then((latest) => {
          if (stillCurrent()) setLocalPages(latest);
        })
        .catch(() => {});
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
    // A return to the library paints the title this tab last showed, its own
    // rename or a peer's, over the one it remembered. A Page the host deleted
    // or stopped sharing leaves what this tab remembers instead.
    const leaving = host.current;
    if (leaving?.hidden) listingCache.forget(leaving.pageId);
    else if (leaving?.doc) listingCache.retitle(leaving.pageId, leaving.doc.title);
    placementWatch.current?.stop();
    placementWatch.current = null;
    host.release({ ...options, onError: showError });
    resetDocumentUI();
  }
  async function loadProjectDetails(next, projectId) {
    const current = () =>
      host.current === next &&
      !next.authRequired &&
      next.identity?.principal === authentication.current?.identity?.principal;
    if (!current()) return;
    dispatchProjectDetails({ type: "load", projectId });
    setError("");
    try {
      const value = await tool("get_project", { project_id: projectId });
      if (current()) dispatchProjectDetails({ type: "loaded", value });
    } catch (error) {
      if (current()) {
        dispatchProjectDetails({ type: "failed", error: failureMessage(error) });
        showError(error);
      }
    }
  }
  async function install(
    next,
    revision,
    { focus = false, focusEmpty = true, project = null } = {},
  ) {
    if (!host.install(next, revision, authentication.current?.identity?.principal)) {
      await next.close();
      return false;
    }
    bootPreview.dispatch({ type: "installed" });
    setIndex(null);
    setPlacement(null);
    dispatchProjectDetails({ type: "reset", value: project });
    setProjectPages(null);
    // Breadcrumbs show only the Project and parents this account can open.
    // A Project's content document also lists its Pages. A Page created in
    // this tab isn't on the server until it registers, so the location is
    // asked for again as the session registers and connects.
    placementWatch.current?.stop();
    const current = () =>
      host.current === next &&
      !next.authRequired &&
      next.identity?.principal === authentication.current?.identity?.principal;
    const watch = watchPageLocation(next, {
      locate: () => pageLocation(tool, next.pageId),
      current,
      onFound: (value) => {
        setPlacement((shown) => shown ?? value);
        if (value.project_id && project?.project_id !== value.project_id)
          void loadProjectDetails(next, value.project_id);
        if (value.kind === "project" && value.project_id) {
          // Only disclosed Project metadata may canonicalize a legacy document link.
          setProjectOpen(value.project_id);
          writePageRoute(value.project_id, { replace: true });
          void listProjectPages(tool, value.project_id).then(
            (pages) => {
              if (current()) setProjectPages({ pageId: next.pageId, pages });
            },
            () => {},
          );
        }
      },
    });
    placementWatch.current = watch;
    const listRecoveries = () =>
      void next
        .listRecoveries()
        .then((records) => {
          if (host.current === next) setLocalRecoveries(records);
        })
        .catch(() => {});
    // The inline composer's draft lives only here. A refusal reads it into
    // the recovery archive before the UI resets.
    next.watchCommentDrafts(() => {
      if (host.current !== next) return [];
      const { composer: current, body } = composer.snapshot();
      if (!current || !hasDraftText(body)) return [];
      return [
        {
          kind: "comment",
          ...draftRecord(body),
          quote: current.quote,
          anchor: current.draft,
        },
      ];
    });
    // A refusal hides the Page at once and archives its copy afterwards:
    // list the archive again each time a write settles, a retry included.
    let hiding = next.hidden,
      settled = next.phase$.snapshot().name;
    next.subscribe(() => {
      if (host.current === next) {
        paint((n) => n + 1);
        watch.changed();
        if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
        if (next.hidden && !hiding) {
          hiding = true;
          resetDocumentUI();
        }
        const phase = next.phase$.snapshot().name;
        if ((phase === "retired" || phase === "retireFailed") && phase !== settled)
          listRecoveries();
        settled = phase;
      }
    });
    listRecoveries();
    // A short note the open left, such as a discarded local copy.
    if (next.openNotice) setNotice(next.openNotice);
    if (next.accessReloadRequired && !next.recoveryPending) void reloadAccess(next);
    const first = next.doc ? (editor.module.orderedBlockIds(next.doc)[0] ?? null) : null;
    activateBlock(first);
    // An empty Page opens with the caret in its empty paragraph, where
    // a pointer and keyboard are ready for it. A new Page names itself first,
    // and a phone keeps its keyboard down until someone taps.
    const empty =
      focusEmpty &&
      next.canWrite &&
      editor.module.isEmptyPage(next.doc) &&
      matchMedia("(pointer: fine)").matches;
    if (focus || empty) setFocusBlock(first);
    return true;
  }
  function reloadAccess(previous = host.current) {
    // Reload waits while the old replica archives and closes, e.g. when a
    // restored Page moves from its reader replica to the writer replica.
    return host.reloadAccess(previous, { install, onError: showError });
  }
  function downloadDraft(record, { bundle = false } = {}) {
    let draft;
    try {
      draft = bundle
        ? host.current?.exportRecoveries(localRecoveries)
        : host.current?.exportRecovery(record);
    } catch (error) {
      showError(error);
      return;
    }
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.page_id}-local-${bundle ? "copies" : "draft"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function saveRecoveryCopy() {
    const current = host.current;
    try {
      await current.saveRecoveryCopy();
      if (host.current !== current) return;
      const records = await current.listRecoveries();
      if (host.current !== current) return;
      setLocalRecoveries(records);
    } catch (error) {
      if (host.current === current) showError(error);
    }
  }
  /** Open a Page. `nameIt` is for a Page just created: focus its title
   * rather than its empty body. Project routes resolve their content document
   * inside the same fenced navigation, without rewriting the address. */
  async function open(
    id,
    { focus = false, historyMode = "push", nameIt = false, projectId = null, anchor = null } = {},
  ) {
    if (historyMode !== "none")
      writePageRoute(projectId ?? id, { replace: historyMode === "replace", anchor });
    headingScroll.navigated(projectId ?? id);
    bootPreview.dispatch({ type: "navigated", pageId: id });
    picker.close();
    setNotice("");
    setUnopened(null);
    setProjectOpen(projectId);
    if (id && host.current?.pageId === id) {
      const placed = screen.current.placement;
      if (placed?.kind === "project" && placed.project_id) {
        setProjectOpen(placed.project_id);
        writePageRoute(placed.project_id, { replace: true });
      }
      return;
    }
    const controller = new AbortController();
    const revision = host.navigate(controller);
    setError("");
    setOpening(true);
    releaseCurrent();
    try {
      // A quick Back may revisit a replica whose final local checkpoint is
      // still flushing. Wait only for that same Page, never an unrelated one.
      const principal = authentication.current?.identity?.principal;
      let project = null;
      if (projectId) {
        project = await tool("get_project", { project_id: projectId });
        if (!navigationCurrent(revision, principal)) return;
        id = project.document_id;
        if (!id) throw new Error("This Project has no document to open.");
      }
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
      if (nameIt) {
        if (await install(next, revision, { focusEmpty: false })) setTitleFocusRequest(next);
      } else await install(next, revision, { focus, project });
    } catch (error) {
      if (host.isCurrent(revision)) bootPreview.dispatch({ type: "refused" });
      // A Page in a format the host doesn't open gets its own screen, where
      // its owner can move it to Trash. Project content is left to its
      // Project.
      if (host.isCurrent(revision) && !projectId && formatRefused(error))
        setUnopened({ pageId: id, principal: authentication.current?.identity?.principal });
      else if (host.isCurrent(revision) && !bannerShows(error)) showError(error);
    } finally {
      host.finishRequest(controller);
      if (host.isCurrent(revision)) setOpening(false);
    }
  }
  /** Show the Pages library at /, with `library` as its view. */
  function home(
    event,
    { historyMode = "push", refreshCatalog = true, library = LIBRARY_DEFAULTS } = {},
  ) {
    if (event) {
      if (!isPlainNavigation(event)) return;
      event.preventDefault();
    }
    host.navigate();
    headingScroll.navigated(null);
    bootPreview.dispatch({ type: "navigated", pageId: null });
    releaseCurrent();
    setAccount(authentication.current?.identity ?? null);
    setError("");
    setNotice("");
    setOpening(false);
    picker.close();
    setTrashOpen(false);
    setUnopened(null);
    setProjectOpen(null);
    setIndex(listingVisit("home", library));
    if (historyMode !== "none")
      writeRoute(libraryPath("/", library), {
        replace: historyMode === "replace",
        state: { pageId: null },
      });
    if (refreshCatalog) void refresh().catch((error) => showError(error));
  }
  /** A new visit to a listing screen, for setIndex. */
  function listingVisit(kind, library = LIBRARY_DEFAULTS) {
    return {
      kind,
      library,
      visit: ++indexVisits.current,
      principal: authentication.current?.identity?.principal ?? null,
    };
  }
  function openProject(projectId, { historyMode = "push", anchor = null } = {}) {
    if (host.current && placement?.kind === "project" && placement.project_id === projectId) {
      if (historyMode !== "none")
        writePageRoute(projectId, { replace: historyMode === "replace", anchor });
      headingScroll.navigated(projectId);
      setProjectOpen(projectId);
      return;
    }
    return open(null, { projectId, historyMode, anchor });
  }
  /** A link in Page content to another Page or Project (HeadingAnchors). */
  function openRoute(route, anchor) {
    if (route.kind === "page") {
      headingScroll.request(route.pageId, anchor);
      void open(route.pageId, { anchor });
    } else if (route.kind === "project") {
      headingScroll.request(route.projectId, anchor);
      void openProject(route.projectId, { anchor });
    }
  }
  /** Show an index route (readPageRoute's `projects` or `pages`). */
  function openIndex(route, { historyMode = "push" } = {}) {
    home(null, { historyMode: "none", refreshCatalog: false });
    if (historyMode !== "none") writeRoute(route.path, { replace: historyMode === "replace" });
    setIndex(listingVisit(route.kind, route.library));
  }
  /** The Pages · Projects nav and the switcher's index links. Pages opens
   * the library at /. */
  function navigateIndex(kind) {
    if (kind === "projects") openIndex(readPageRoute(PROJECTS_PATH));
    else home(null);
  }
  /** Whether listing visit `visit` is still on screen for the account that
   * started it, at a listing address. */
  const indexCurrent = (visit, principal) => {
    const route = readPageRoute(location.href);
    return (
      indexVisits.current === visit &&
      authentication.current?.identity?.principal === principal &&
      (isIndexRoute(route) || isLibraryRoute(route))
    );
  };
  /** A listing failure goes to the screen's banner like any failed action,
   * while its screen is still the one showing. */
  const reportListing = (visit, principal) => (message) => {
    if (indexCurrent(visit, principal)) setError(message);
  };
  /** A view chosen in the library: the address and the visit's view follow
   * it, so Back, a reload, or a remount after a failed Page open show it
   * again. A choice pushes a history entry; a typed search replaces it. A
   * visit whose address moved on (to the Page it is opening) leaves the
   * address alone. */
  const followLibrary =
    (visit, principal) =>
    (library, { replace }) => {
      const route = readPageRoute(location.href);
      if (!indexCurrent(visit, principal) || !isLibraryRoute(route)) return;
      setIndex((current) => (current?.visit === visit ? { ...current, library } : current));
      writeRoute(libraryPath(libraryBase(route), library), { replace, state: { pageId: null } });
    };
  /** The library's view at an address no visit owns: after a Page closed
   * without navigating (moved to Trash, say), / shows the library. */
  const libraryOf = (route) => (isLibraryRoute(route) ? route.library : LIBRARY_DEFAULTS);
  const followAddress = (library, { replace }) => {
    const route = readPageRoute(location.href);
    if (host.current || !isLibraryRoute(route)) return;
    writeRoute(libraryPath(libraryBase(route), library), { replace, state: { pageId: null } });
  };
  const reportAddressListing = (message) => {
    if (!host.current && isLibraryRoute(readPageRoute(location.href))) setError(message);
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
      // The Page is back in the views that list the account's own Pages.
      listingCache.forgetOwnedViews();
      await reopen(restoring.pageId, { restore: true });
      setNotice("Page restored");
      void refresh().catch(() => {});
    } catch (error) {
      showError(error);
    }
  }
  /** Whether the library is on screen for the signed-in account. */
  function libraryShowing() {
    const shown = screen.current;
    return (
      !host.current &&
      !!shown &&
      !shown.opening &&
      !shown.projectOpen &&
      !shown.trashOpen &&
      !shown.unopened &&
      isLibraryRoute(shown.index) &&
      shown.index.principal === authentication.current?.identity?.principal
    );
  }
  function followRoute() {
    const route = readPageRoute(location.href);
    // The stopped screen belongs to the address that showed it; a Page
    // route that still refuses shows it again from open().
    setUnopened(null);
    // Back or Forward from one library address to another: the mounted
    // library takes the view, so a grouping alone asks for nothing and focus
    // stays put. The address keeps the canonical form.
    if (isLibraryRoute(route) && libraryShowing()) {
      setError("");
      setNotice("");
      picker.close();
      setIndex((current) =>
        current ? { ...current, kind: route.kind, library: route.library } : current,
      );
      writeRoute(route.path, { replace: true, state: { pageId: null } });
      return;
    }
    if (route.kind === "page") void open(route.pageId, { historyMode: "replace" });
    // Replace keeps the address canonical when an older /s/ link opened it.
    else if (route.kind === "project") openProject(route.projectId, { historyMode: "replace" });
    // Replace drops a trailing slash or an empty search from the address.
    else if (isIndexRoute(route)) openIndex(route, { historyMode: "replace" });
    // Replace drops unknown or default parameters from the address.
    else if (route.kind === "home")
      home(null, { historyMode: "replace", refreshCatalog: false, library: route.library });
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
  // Link previews resolve for the account shown; another drops them all.
  useEffect(() => pageRefs.account(account?.principal ?? null), [account]);
  // The Browse picker reports here.
  useEffect(() => {
    pickerHooks.report = (message) => setPickerError(message);
    return () => {
      pickerHooks.report = () => {};
      picker.close();
    };
  }, []);
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
        // Before anything renders for the new answer: a different or no
        // account retires the boot preview.
        bootPreview.dispatch({ type: "session", principal: result.identity?.principal ?? null });
        const changed = authentication.current?.identity?.principal !== result.identity?.principal;
        if (changed) {
          host.navigate();
          // Attempts to replay belong to the account that made them.
          creations.account(result.identity?.principal ?? null);
          // The stopped screen answered for the account that opened it.
          setUnopened(null);
          catalogRevision.current++;
          // Rows and Projects remembered for one account never show another.
          forgetAccountData();
          setLocalPages([]);
          setQuota(null);
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
      onError: (error, { notice }) => {
        if (!alive) return;
        const banner = sessionCheckBanner(error, { notice });
        if (banner !== undefined) setSessionNotice({ message: banner, signIn: false });
        setAccount((value) => (value === undefined ? null : value));
      },
    });
    auth.current = maintenance;
    // A tool call refused as signed out, or answered for another account
    // (signed-out-recovery.mjs): after a refusal, what this tab remembers for
    // the account goes at once. Either way the session check decides who is
    // signed in now. When it answers with the same account, the account's
    // Projects are asked for again. One check runs at a time, a refusal or
    // another account's answer during it runs it once more, and reruns are
    // capped, so a server that keeps refusing tool calls, or keeps answering
    // for someone else, can't loop the tab. When it ends, a Browse picker
    // waiting on a check that started after its walk's answer says to try
    // again if the account is the same, or that the check failed; an account
    // change already closed it.
    const recovery = new SignedOutRecovery({
      forget: forgetRefusedAccountData,
      // Rejects only when the session check didn't answer: the Projects
      // request after it doesn't change who is signed in.
      check: async () => {
        const before = authentication.current?.identity?.principal ?? null;
        await maintenance.refresh();
        const now = authentication.current?.identity?.principal ?? null;
        if (alive && now && now === before)
          await projectList.request(now, { fresh: true }).catch(() => {});
      },
      done: ({ generation, outcome }) => {
        if (alive)
          picker.settled({
            principal: authentication.current?.identity?.principal ?? null,
            outcome,
            generation,
          });
      },
    });
    const stopSignedOut = observeSignedOut(() => {
      if (alive) recovery.refused();
    });
    accountHooks.otherAccount = () => {
      if (alive) recovery.otherAccount();
    };
    accountHooks.generation = () => recovery.generation;
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
      stopSignedOut();
      accountHooks.otherAccount = () => {};
      accountHooks.generation = () => 0;
      recovery.stop();
      maintenance.stop();
      window.removeEventListener("popstate", onPopState);
      catalogRevision.current++;
      placementWatch.current?.stop();
      host.navigate();
      void host.close(host.current);
    };
  }, []);
  const page = session?.snapshot(),
    threads = page?.comments ?? [];
  // The Project whose content is open. A link to it there is no Project link
  // (current-page.mjs); in an ordinary Page of the Project it still is.
  // projectOpen alone: it's set with the placement that finds the content and
  // cleared the moment another Page opens, while `placement` lingers until the
  // next session installs.
  const currentProjectId = projectOpen ?? null;
  const shownPreview = page
    ? null
    : visiblePreview(bootPreviewState, {
        pageId: readPageRoute(location.href).pageId,
        principal: account?.principal,
      });
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
  // React writes a peer's title into the focused input, which moves the
  // caret to the end. Resolve the selection's cursors in the new document.
  const shownTitle = page?.title;
  const [titleComposing, setTitleComposing] = useState(null);
  // A composition belongs to the Page it began on.
  useEffect(() => {
    titleCompositionRef.current = null;
    setTitleComposing(null);
  }, [session]);
  // The owner's tab draws the Page's grid card images (card-capture.mjs);
  // it watches the session for the owner's access itself.
  useEffect(() => (session ? editor.module?.captureCards?.(session) : undefined), [session]);
  function composing() {
    const state = titleCompositionRef.current;
    return !!state && !!editor.module?.composingTitle(state, session);
  }
  function titleBase() {
    const seen = titleSelection.current;
    return seen?.session === session ? seen : null;
  }
  // Every title input event goes through one transition (titleInput in
  // title-selection.mjs); its effect runs here.
  function titleEvent(event, input) {
    const module = editor.module;
    if (!module || !session) return;
    const { state, effect } = module.titleInput(titleCompositionRef.current ?? module.TITLE_IDLE, {
      ...event,
      session,
    });
    titleCompositionRef.current = state;
    setTitleComposing(module.composingTitle(state, session) ? state.value : null);
    if (effect?.type !== "commit") return;
    try {
      commitTitle(input, effect.base);
    } catch (error) {
      showError(error);
    }
  }
  // One title keystroke, or a finished composition, read against the
  // revision the input showed and written to the current document. When a
  // peer's change React hadn't shown yet was kept, the input shows the merged
  // title with the caret carried across, so it matches a revision again.
  function commitTitle(input, base) {
    const module = editor.module;
    const value = input.value;
    const plan = module.titleChange(session.doc, base, value, input.selectionStart);
    if (!plan) return;
    session.change((doc) => module.writeTitle(doc, plan.edits));
    if (session.doc.title !== value) {
      input.value = session.doc.title;
      input.setSelectionRange(plan.caret, plan.caret);
    }
    rememberTitleSelection(input);
  }
  function rememberTitleSelection(input = titleInput.current) {
    const module = editor.module;
    // While an IME composes, the snapshot stays on the revision it began on.
    if (!input || !session || !module || composing()) return;
    const previous = titleSelection.current;
    const snapshot = module.titleSnapshot(
      session.doc,
      previous?.input === input && previous.session === session ? previous : null,
      input.value,
      input.selectionStart,
      input.selectionEnd,
    );
    if (snapshot)
      titleSelection.current = { ...snapshot, input, session, direction: input.selectionDirection };
  }
  useLayoutEffect(() => {
    const input = titleInput.current,
      seen = titleSelection.current;
    if (!input || shownTitle === undefined) return;
    if (
      seen?.input === input &&
      seen.session === session &&
      seen.value !== shownTitle &&
      session.doc.title === shownTitle &&
      !composing() &&
      document.activeElement === input
    ) {
      const next = editor.module?.resolveTitleSelection(session.doc, seen.cursors);
      if (next) input.setSelectionRange(next.start, next.end, seen.direction);
    }
    rememberTitleSelection(input);
  }, [shownTitle, session]);
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
  /** New Page in Your items, as a local draft. One creation runs at a time,
   * placed or not (pageCreations in page-create-machine.mjs). */
  async function create() {
    if (creations.pending || host.current?.authRequired) return;
    await creations.exclusive(createDraft);
  }
  async function createDraft() {
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
      picker.close();
      setOpening(false);
      setNotice("");
      // The account's own views gain the new Page.
      listingCache.forgetOwnedViews();
      if (await install(next, revision, { focusEmpty: false })) setTitleFocusRequest(next);
      void refresh().catch(() => {});
    } catch (error) {
      if (host.isCurrent(revision) && !bannerShows(error)) {
        showError(error);
        setPickerError(failureMessage(error));
      }
    } finally {
      setCreating(false);
    }
  }
  /** New Page in a Project or under a Page (`{ project_id }` or
   * `{ parent_id }`), then open it. A cancellable draft like create(): a
   * navigation or account change before create_page writes nothing, and one
   * during it leaves the new Page closed (page-create-machine.mjs). */
  async function createIn(placement) {
    const principal = authentication.current?.identity?.principal;
    if (creations.pending || host.current?.authRequired || !principal) return;
    setCreating(true);
    setError("");
    setPickerError("");
    const revision = host.navigate();
    const current = () => navigationCurrent(revision, principal);
    try {
      const state = await creations.create({
        principal,
        placement,
        call: tool,
        current,
        // A new Page names itself first, like create()'s draft.
        open: (pageId) => open(pageId, { nameIt: true }),
        refresh: () => {
          // The account's own views may gain the new Page.
          listingCache.forgetOwnedViews();
          return refresh({ fresh: true });
        },
      });
      if (state?.name === "failed" && current() && !bannerShows(state.cause)) {
        showError(state.cause);
        setPickerError(failureMessage(state.cause));
      }
    } finally {
      setCreating(false);
    }
  }
  async function copyLink(pageId = host.current?.pageId, path = null) {
    if (!pageId) return;
    try {
      const projectId =
        pageId === host.current?.pageId &&
        (projectOpen || (placement?.kind === "project" && placement.project_id));
      await navigator.clipboard.writeText(
        new URL(path ?? (projectId ? projectPath(projectId) : pagePath(pageId)), location.origin)
          .href,
      );
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
  /** The visible "More page actions" button (desktop or phone header),
   * where focus goes back when the Move dialog closes. */
  function pageMenuButton() {
    return [...document.querySelectorAll('button[aria-label="More page actions"]')].find(
      (button) => button.getClientRects().length > 0,
    );
  }
  /** Move to…: only the Page's owner, signed in as that account, moves it.
   * The dialog starts where read_page says the Page is, asked here when the
   * shell doesn't know yet. Project content cannot be moved as a Page. */
  async function startMove() {
    const moving = host.current;
    if (!moving) return;
    if (
      moving.authRequired ||
      moving.identity.principal !== authentication.current?.identity?.principal
    ) {
      setError("Sign in with this Page's original account to move it.");
      return;
    }
    let where = placement;
    // A draft the host hasn't registered isn't on the server to move yet.
    if (!where && moving.localPage?.registration && !moving.localPage.registered) {
      setError("Wait for this Page to sync before moving it.");
      return;
    }
    if (!where) {
      try {
        where = await pageLocation(tool, moving.pageId);
      } catch (error) {
        showError(error);
        return;
      }
      if (host.current !== moving) return;
      // The account may have changed while read_page was in flight; its
      // answer then isn't shown either.
      if (moving.identity.principal !== authentication.current?.identity?.principal) {
        setError("Sign in with this Page's original account to move it.");
        return;
      }
      setPlacement(where);
    }
    if (where.kind === "project") {
      setError("A Project cannot be moved into another Project.");
      return;
    }
    const projectCrumb = where.breadcrumbs.find((crumb) => crumb.kind === "project");
    setContainerDialog({
      kind: "move",
      pageId: moving.pageId,
      title: page?.title,
      origin: moveOrigin(where),
      currentProject: where.project_id
        ? { project_id: where.project_id, title: projectCrumb?.title }
        : null,
    });
  }
  /** A move landed: the Page list, Projects and breadcrumbs follow it. */
  function moved(receipt) {
    setContainerDialog(null);
    const where = receipt.project_id
      ? projects.find((project) => project.project_id === receipt.project_id)?.title || "Project"
      : "Your items";
    setNotice(`Moved to ${where}`);
    // The Page and its sub-pages left one Project's views for another's, and
    // their Project labels changed.
    listingCache.forgetOwnedViews();
    void refresh({ fresh: true }).catch(() => {});
    const current = host.current;
    if (current?.pageId === receipt.page_id)
      void pageLocation(tool, current.pageId).then(
        (value) => {
          if (host.current === current) setPlacement(value);
        },
        () => {},
      );
  }
  /** A Project was created: list it and open it. */
  function projectCreated(projectId) {
    setContainerDialog(null);
    void refresh({ fresh: true }).catch(() => {});
    openProject(projectId);
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
      if (deleting.identity.principal !== authentication.current?.identity?.principal)
        throw Error("Sign in with this Page's original account to move it to Trash.");
      // The heads this tab shows guard the move: a peer's edit that lands first
      // refuses it (BROWSER_TRASH_GUARD in worker/tool-arguments.mjs). A Page
      // the host stopped for its format has no heads the host can match.
      const trashed = await tool(
        "delete_page",
        trashArguments({
          pageId: deleting.pageId,
          principal: deleting.identity.principal,
          nonce: crypto.randomUUID(),
          heads: sessionFormatStopped(deleting) ? undefined : editor.module.pageHeads(deleting.doc),
        }),
      ).catch((error) => {
        throw moveToTrashError(error);
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
      // the host never registered has no Trash entry, so move it to the
      // recovery archive instead of leaving it listed as saved locally.
      if (!deleting.localPage?.registered) {
        await closing;
        await retireLocalPage(deleting.identity, deleting.pageId, {
          reason: "deleted",
          grant: deleting.replicaKey,
          revision: deleting.access?.revision,
        });
      }
      // A return to the library mustn't paint it from memory.
      listingCache.forget(deleting.pageId);
      setNotice("Moved to Trash");
      await refresh();
    } catch (error) {
      showError(error);
    }
  }
  async function signout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
      await leaveSignedOut();
    } catch (error) {
      showError(error);
    }
  }
  /** The host has ended this browser's session: forget the account here. */
  async function leaveSignedOut() {
    forgetAccountData();
    let failed;
    await host.close(host.current, { onError: (error) => (failed = error) });
    if (failed) throw failed;
    location.href = "/";
  }
  // Comment on a selection opens the inline composer beside it. Readers
  // without comment access get the thread list instead.
  function startComment(id, selected) {
    if (!session || !id || !selected) return;
    activateBlock(id);
    if (!session.canComment) {
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
    const trigger = commentsButton.current;
    const closingFocus = document.activeElement;
    const closingSession = host.current;
    setCommentsOpen(false);
    if (
      closingFocus !== trigger &&
      closingFocus !== document.body &&
      !document.getElementById("page-comments")?.contains(closingFocus)
    )
      return;
    requestAnimationFrame(() => {
      // Native dialog close can already return focus. A later frame must not
      // overwrite a new editor/control selection or a different Page's focus.
      const active = document.activeElement;
      if (
        trigger?.isConnected &&
        commentsButton.current === trigger &&
        host.current === closingSession &&
        trigger.getAttribute("aria-expanded") === "false" &&
        (active === closingFocus || active === document.body || active === trigger)
      )
        trigger.focus({ preventScroll: true });
    });
  }
  function toggleComments() {
    if (commentsOpen) closeComments();
    else setCommentsOpen(true);
  }
  useEffect(() => {
    const element = article.current;
    if (!element || !commentsOpen) return;
    const over = (event) =>
      setHoveredThread(event.target.closest?.(".comment-passage")?.dataset.commentThread ?? null);
    const leave = () => setHoveredThread(null);
    element.addEventListener("pointerover", over);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointerover", over);
      element.removeEventListener("pointerleave", leave);
      setHoveredThread(null);
    };
  }, [commentsOpen, session?.pageId]);
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
    // /pages is headed "Pages", the product name, so its tab is the product
    // name alone rather than "Pages · Pages".
    document.title = tabTitle(
      page
        ? page.title || "Untitled"
        : index?.kind === "projects" && !projectOpen && !trashOpen && !opening
          ? "Projects"
          : undefined,
    );
  }, [page?.title, index, projectOpen, trashOpen, opening]);
  // The open Page's title as this tab has it, over a listing's older copy.
  const ownTitle = (item) =>
    item.page_id === page?.page_id ? { ...item, title: page.title } : item;
  const listedPages = mergePageListings(pickerFailed ? null : pickerSnapshot.items, localPages).map(
    ownTitle,
  );
  // The open Page's Project role, from get_project or list_projects.
  const placementRole = placement?.project_id
    ? (projectDetails.value?.project_id === placement.project_id && projectDetails.value.role) ||
      projects.find((project) => project.project_id === placement.project_id)?.role ||
      null
    : null;
  // The Project's owner and editors add Pages to it; a Page an editor adds
  // belongs to the Project owner. Viewers and commenters read the tree.
  // Moving and trashing stay with the owner (session.canDelete).
  const addsToProject =
    !!placement?.project_id &&
    !!session &&
    !session.authRequired &&
    session.pageId === host.current?.pageId &&
    session.identity?.principal === authentication.current?.identity?.principal &&
    (!!session.canDelete || (!!session.canWrite && ["owner", "editor"].includes(placementRole)));
  const placementProject = placement?.project_id
    ? (projects.find((project) => project.project_id === placement.project_id) ??
      placement.breadcrumbs.find((crumb) => crumb.kind === "project"))
    : null;
  const projectPagesShown =
    !!placement?.project_id && !!page && projectPages?.pageId === page.page_id;
  const projectPagesList = projectPagesShown
    ? projectPages.pages.filter((item) => item.project_id === placement.project_id).map(ownTitle)
    : [];
  const usage = quotaNotice(quota);
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
        {
          key: "save-recovery",
          label: "Save recovery copy",
          run: saveRecoveryCopy,
        },
        projectDetails.name === "failed" && {
          key: "retry-project-access",
          label: "Retry Project access",
          run: () => loadProjectDetails(session, projectDetails.projectId),
        },
        recoveryDownloadAction(localRecoveries, downloadDraft),
        session.canRestore && {
          key: "restore",
          label: "Restore from Trash",
          icon: RotateCcw,
          run: restoreCurrent,
        },
        // Project content cannot be moved as a Page. Until read_page says
        // where the Page is, Move to… asks when chosen (startMove).
        session.canDelete &&
          !projectOpen &&
          placement?.kind !== "project" && {
            key: "move",
            label: "Move to…",
            icon: FolderInput,
            run: startMove,
          },
        addsToProject &&
          placement.kind !== "project" && {
            key: "new-sub-page",
            label: "New sub-page",
            icon: FilePlus,
            run: () => createIn({ parent_id: session.pageId }),
          },
        // read_page never answers for a Page the host stopped for its format,
        // so its placement stays unknown and the host decides.
        session.canDelete &&
          !projectOpen &&
          (placement
            ? placement.kind !== "project"
            : (sessionFormatStopped(session) ||
                (session.localPage?.registration && !session.localPage.registered)) &&
              !session.authRequired &&
              session.identity?.principal === authentication.current?.identity?.principal) && {
            key: "trash",
            label: "Move to Trash",
            icon: Trash2,
            danger: true,
            run: remove,
          },
      ].filter(Boolean)
    : [];
  const body = (
    <div className={page ? "app has-document" : "app"} onKeyDownCapture={formattingShortcut}>
      <header className="app-header">
        <div className="header-navigation">
          <a href="/" className="brand" onClick={account ? home : undefined}>
            {PRODUCT_NAME}
          </a>
          {account && (
            <button
              className={`subtle-button pages-trigger${page ? " document-switcher" : ""}`}
              aria-label={`${page?.title || (page ? "Untitled" : "Browse")}, switch page`}
              title="Switch page"
              onClick={() => {
                setPickerError("");
                picker.open(authentication.current?.identity?.principal ?? null);
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
                  project={
                    projectOpen || (placement?.kind === "project" && placement.project_id)
                      ? (projectDetails.value ?? {
                          project_id: projectOpen ?? placement.project_id,
                          role: projectDetails.name === "failed" ? "unavailable" : "unknown",
                        })
                      : null
                  }
                  tool={tool}
                  inheritedProject={
                    placement?.project_id ? placementProject?.title || "Project" : null
                  }
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
                {authentication.current?.accountControls === true && !agentsMissing && (
                  <button
                    onClick={() => {
                      accountDisclosure.current.open = false;
                      setAgentsOpen(true);
                    }}
                  >
                    <Unplug size={16} aria-hidden="true" /> Connected agents
                  </button>
                )}
                <button onClick={signout}>
                  <LogOut size={16} aria-hidden="true" /> Sign out
                </button>
              </div>
            </details>
          )}
          {account && agentsOpen && (
            <ConnectedAgents
              returnFocus={() => accountDisclosure.current?.querySelector("summary")}
              onClose={() => setAgentsOpen(false)}
              onSignedOut={() => void leaveSignedOut().catch(showError)}
              onUnavailable={() => setAgentsMissing(true)}
            />
          )}
        </div>
      </header>
      {/* Sticks under the header: the pinned toolbar, then the reload banner. */}
      <div className="status-stack">
        {page && <div id="page-formatting" className="toolbar-host" ref={setToolbar} />}
        <BuildUpdate
          session={session}
          principal={authentication.current?.identity?.principal}
          onOpenPage={(id) => void open(id)}
          editorUnavailable={editorUnavailable && !!account}
        />
      </div>
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
          <h1>
            {["page", "project"].includes(readPageRoute(location.href).kind)
              ? `Sign in to open this ${readPageRoute(location.href).kind === "project" ? "Project" : "Page"}.`
              : "A place to write together."}
          </h1>
          <p>Shared documents that people and agents edit together. Agents connect over MCP.</p>
          <div className="welcome-actions">
            <a
              className="primary"
              href={`/api/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}
            >
              Sign in
            </a>
            <a href="/connect">Connect an agent</a>
          </div>
        </main>
      ) : (
        <>
          <PagePicker
            open={pickerOpen}
            pages={listedPages}
            loading={pickerLoading}
            currentId={page?.page_id}
            onClose={() => picker.close()}
            onOpen={open}
            onCreate={create}
            createProject={
              addsToProject
                ? { project_id: placement.project_id, title: placementProject?.title }
                : null
            }
            onCreateInProject={(projectId) => createIn({ project_id: projectId })}
            onTrash={showTrash}
            onOpenIndex={navigateIndex}
            projects={projects}
            currentProjectId={projectOpen}
            onOpenProject={(id) => openProject(id)}
            onCreateProject={() => setContainerDialog({ kind: "create" })}
            creating={creating || !!session?.authRequired}
            error={pickerError}
          />
          {containerDialog?.kind === "create" && (
            <ProjectCreator
              tool={tool}
              onClose={() => setContainerDialog(null)}
              onCreated={(receipt) => projectCreated(receipt.project_id)}
            />
          )}
          {containerDialog?.kind === "move" && (
            <MoveDialog
              key={containerDialog.pageId}
              tool={tool}
              pageId={containerDialog.pageId}
              title={containerDialog.title}
              origin={containerDialog.origin}
              currentProject={containerDialog.currentProject}
              returnFocus={pageMenuButton}
              projects={projects}
              onClose={() => setContainerDialog(null)}
              onMoved={moved}
            />
          )}
          {page ? (
            <main
              className={commentsOpen ? "workspace document with-comments" : "workspace document"}
            >
              <article ref={article}>
                <h1 className="document-print-title sr-only">{page.title || "Untitled"}</h1>
                {HeadingAnchors && (
                  <HeadingAnchors
                    article={article}
                    session={session}
                    projectId={projectOpen}
                    scroll={headingScroll}
                    onOpenRoute={openRoute}
                    onNotice={setNotice}
                    onError={setError}
                  />
                )}
                {placement?.kind === "project" && placement.project_id ? (
                  <ProjectChip
                    projectId={placement.project_id}
                    count={projectPagesShown ? projectPagesList.length : null}
                    onOpenProject={(id) => openProject(id)}
                  />
                ) : (
                  <Breadcrumbs
                    crumbs={placement?.breadcrumbs ?? []}
                    onOpenProject={(id) => openProject(id)}
                    onOpenPage={open}
                  />
                )}
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
                {(session.refusalEvidence || session.recoveryCapture?.state.name !== "idle") &&
                  session.recoveryCapture && (
                    <div className="access-notice" role="status">
                      {session.refusalEvidence && (
                        <p>
                          Sync returned {session.refusalEvidence.code}. This does not identify an
                          offending change. Your local copy is unchanged.
                        </p>
                      )}
                      <p>
                        A recovery copy keeps this tab's native Page, comments and available drafts
                        in this browser. Asset files and unfinished input composition are not
                        included.
                      </p>
                      {session.recoveryCapture.state.name === "archived" ? (
                        <p>
                          Recovery copy saved in this browser, not to the host. Later edits are not
                          included.
                        </p>
                      ) : session.recoveryCapture.state.name === "failed" ? (
                        <p>
                          Recovery copy was not confirmed saved. Your active copy is unchanged.
                          Retry keeps the same captured copy.
                        </p>
                      ) : null}
                      <button
                        onClick={saveRecoveryCopy}
                        disabled={["capturing", "persisting"].includes(
                          session.recoveryCapture.state.name,
                        )}
                      >
                        {session.recoveryCapture.state.name === "failed"
                          ? "Retry saving recovery copy"
                          : "Save recovery copy"}
                      </button>
                      {session.recoveryCapture.state.name === "archived" && (
                        <button onClick={() => downloadDraft(session.recoveryCapture.state.record)}>
                          Download recovery copy
                        </button>
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
                  // Prose, not a form field: see prose-entry.mjs.
                  autoComplete="off"
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  maxLength={editor.module?.TITLE_MAX_LENGTH}
                  value={titleComposing ?? page.title}
                  readOnly={!session.canWrite}
                  onSelect={(event) => rememberTitleSelection(event.currentTarget)}
                  onCompositionStart={(event) =>
                    titleEvent(
                      {
                        type: "compositionstart",
                        base: titleBase(),
                        value: event.currentTarget.value,
                      },
                      event.currentTarget,
                    )
                  }
                  onCompositionEnd={(event) =>
                    titleEvent({ type: "compositionend" }, event.currentTarget)
                  }
                  onBlur={(event) =>
                    titleEvent(
                      { type: "blur", value: event.currentTarget.value },
                      event.currentTarget,
                    )
                  }
                  onChange={(event) =>
                    titleEvent(
                      {
                        type: "input",
                        composing: !!event.nativeEvent.isComposing,
                        base: titleBase(),
                        value: event.currentTarget.value,
                      },
                      event.currentTarget,
                    )
                  }
                  onKeyDown={(event) => {
                    if (!titleHandsOffToBody(event, session.canWrite)) return;
                    event.preventDefault();
                    const first = editor.module.orderedBlockIds(session.doc)[0];
                    // Mount and focus the body before the next key: a new Page
                    // has no block yet, and keys typed while one renders would
                    // land in the title.
                    flushSync(() => {
                      if (first) {
                        activateBlock(first);
                        setFocusBlock(first);
                      } else continueWriting();
                    });
                    const id = first ?? editor.module.orderedBlockIds(session.doc)[0];
                    if (id)
                      article.current
                        ?.querySelector(`[data-block-id="${CSS.escape(id)}"] wg-content`)
                        ?.focus();
                  }}
                />
                <PageBlocks
                  blocks={page.blocks}
                  renderBlock={(block) => (
                    <WordgardEditor
                      replica={session}
                      id={block.id}
                      editable={session.canWrite}
                      commentable={session.canComment}
                      onError={setError}
                      onComment={(selected) => startComment(block.id, selected)}
                      onRevealComment={selectComment}
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
                  )}
                />
                {/* Blank space below the last block: a click there puts the
                    caret in an empty paragraph at the end. Its label shows
                    only under keyboard focus, when the editor has no caret,
                    so it can't be mistaken for the caret's line. It stays in
                    the tab order for a last block that ArrowDown and
                    Mod-Enter can't leave: read-only or not rich text. */}
                {session.canWrite && (
                  <button type="button" className="writing-continuation" onClick={continueWriting}>
                    <span className="writing-continuation-label">Continue writing</span>
                  </button>
                )}
                {placement?.project_id && placement.kind === "project" && (
                  <ProjectPages
                    title={placementProject?.title}
                    pages={projectPagesList}
                    onOpen={open}
                    onCreate={
                      addsToProject ? () => createIn({ project_id: placement.project_id }) : null
                    }
                    creating={creating}
                  />
                )}
              </article>
              {marginRequested() && !commentsOpen && (
                <MarginThreads
                  key={`margin-${session.pageId}`}
                  article={article}
                  threads={threads}
                  activeId={target?.id ?? null}
                  onOpen={selectComment}
                />
              )}
              <CommentsPanel
                key={session.pageId}
                open={commentsOpen}
                session={session}
                threads={threads}
                composer={composer}
                target={target}
                principal={account?.principal ?? null}
                hovered={hoveredThread}
                onClose={closeComments}
                onReveal={revealComment}
                onSelect={(id) => {
                  // Panel selections highlight the passage without drilling in.
                  setTarget({ id, request: performance.now(), source: "panel" });
                }}
              />
              <CommentPopover
                key={`popover-${session.pageId}`}
                composer={composer}
                session={session}
                containerRef={article}
              />
            </main>
          ) : session?.hidden ? (
            <RetiredPage
              session={session}
              recoveries={localRecoveries}
              onDownload={downloadDraft}
              onRetry={() => void session.retryRetirement()}
              onHome={() => home(null)}
            />
          ) : opening ? (
            shownPreview ? (
              <PagePreview
                preview={shownPreview}
                pageId={readPageRoute(location.href).pageId}
                projectId={currentProjectId}
              />
            ) : (
              <main className="welcome">
                <p role="status">Opening…</p>
              </main>
            )
          ) : unopened && unopened.principal === account.principal ? (
            <UnopenedPage
              key={`${unopened.pageId}:${unopened.principal}`}
              pageId={unopened.pageId}
              principal={unopened.principal}
              request={request}
              tool={tool}
              onTrashed={(pageId) => {
                // A return to the library mustn't paint it from memory.
                listingCache.forget(pageId);
                home(null, { historyMode: "replace" });
                setNotice("Moved to Trash");
              }}
              onOpenTrash={showTrash}
              onHome={() => home(null)}
            />
          ) : projectOpen ? (
            <main className="welcome">
              <button
                type="button"
                className="subtle-button"
                onClick={() => openProject(projectOpen, { historyMode: "none" })}
              >
                Retry opening Project
              </button>
              <a
                href={PROJECTS_PATH}
                onClick={(event) => {
                  if (!isPlainNavigation(event)) return;
                  event.preventDefault();
                  navigateIndex("projects");
                }}
              >
                Back to Projects
              </a>
            </main>
          ) : index?.kind === "projects" ? (
            <ProjectsIndex
              key={index.visit}
              tool={tool}
              requestProjects={() => projectList.request(index.principal)}
              onNavigate={navigateIndex}
              onOpenProject={(id) => openProject(id)}
              onProjectCreated={projectCreated}
              onError={reportListing(index.visit, index.principal)}
              onRetry={retryListing}
            />
          ) : trashOpen ? (
            <TrashView
              tool={tool}
              principal={account.principal}
              identity={authentication.current?.identity}
              onBack={() => home(null)}
              onOpen={(id) => open(id)}
              onRestored={async () => {
                listingCache.forgetOwnedViews();
                setNotice("Page restored");
                await refresh().catch(() => {});
              }}
              onPurged={async () => {
                setNotice("Page deleted permanently");
                await refresh().catch(() => {});
              }}
            />
          ) : (
            <Library
              key={index?.visit ?? "address"}
              tool={tool}
              principal={index?.principal ?? account.principal}
              view={index?.library ?? libraryOf(readPageRoute(location.href))}
              projects={projects}
              drafts={localPages}
              notice={usage}
              creating={creating}
              onNavigate={navigateIndex}
              onViewChange={index ? followLibrary(index.visit, index.principal) : followAddress}
              onOpen={(id) => open(id)}
              onOpenProject={(id) => openProject(id)}
              onCreate={create}
              onTrash={showTrash}
              onCopyLink={copyLink}
              onWarm={warmEditor}
              onError={index ? reportListing(index.visit, index.principal) : reportAddressListing}
              onRetry={retryListing}
              onAnswer={({ quota: value, principal: answeredBy }) => {
                // Checked when the answer lands: the account may have changed
                // since this library mounted.
                const current = authentication.current?.identity?.principal;
                if (answeredBy && answeredBy !== current) {
                  // The cookie belongs to someone else now (another window
                  // signed in). The session check settles who.
                  accountHooks.otherAccount();
                  return;
                }
                if ((index?.principal ?? account.principal) === current) setQuota(value);
              }}
            />
          )}
        </>
      )}
      {/* The hover card for links to other Pages and to Projects, in Page
          blocks and comments alike. It opens nothing while this tab knows
          no account. */}
      <PageLinkCard
        refs={pageRefs}
        currentPageId={session?.pageId ?? null}
        currentProjectId={currentProjectId}
        onOpenRoute={openRoute}
      />
    </div>
  );
  // Page blocks and comments read what's open, whose own links get no glyph.
  return (
    <CurrentPage.Provider value={session?.pageId ?? null}>
      <CurrentProject.Provider value={currentProjectId}>{body}</CurrentProject.Provider>
    </CurrentPage.Provider>
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

createRoot(document.getElementById("root")).render(
  <ScreenBoundary>
    <App />
  </ScreenBoundary>,
);
