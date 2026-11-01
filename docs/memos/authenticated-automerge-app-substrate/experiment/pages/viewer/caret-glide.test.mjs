import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { BehaviorSubject } from "rxjs";
import {
  GLIDE_HANDOFF_MS,
  HIDDEN,
  createCaretGlide,
  glideTransition,
  createGlideRunner,
  mediaMatches$,
} from "./caret-glide.mjs";

const on = { enabled: true, reducedMotion: false, maxJumpPx: 900 };
const at = (anchor, x, y, extra = {}) => ({
  type: "observed",
  anchor,
  block: "one",
  x,
  y,
  height: 20,
  at: 1000,
  ...extra,
});
const resting = { name: "resting", anchor: "a1", block: "one", x: 10, y: 20, height: 20 };
const gliding = { ...resting, name: "gliding", from: { x: 0, y: 0, height: 20 } };
const recent = {
  name: "hidden",
  last: { anchor: "a1", block: "one", x: 10, y: 20, height: 20, at: 900 },
};
const stale = { ...recent, last: { ...recent.last, at: 1000 - GLIDE_HANDOFF_MS - 1 } };

// Every state against every event. `glide` names whether a glide effect comes
// out; `name` is the next state.
const cases = [
  // hidden, nothing remembered: first appearance
  ["first record", HIDDEN, at("a1", 10, 20), on, "resting", null],
  [
    "departure while hidden",
    HIDDEN,
    { type: "departed", block: "one", at: 1000 },
    on,
    "hidden",
    null,
  ],
  ["motion reduced while hidden", HIDDEN, { type: "motion-reduced" }, on, "hidden", null],
  ["settle while hidden", HIDDEN, { type: "settled", anchor: "a1" }, on, "hidden", null],
  // hidden, a caret just left a block
  ["handoff to a new anchor", recent, at("a2", 10, 220, { block: "two" }), on, "gliding", "glide"],
  ["same write reappears", recent, at("a1", 10, 40), on, "resting", null],
  ["handoff after the window", stale, at("a2", 10, 220), on, "resting", null],
  [
    "handoff with motion reduced",
    recent,
    at("a2", 10, 220),
    { ...on, reducedMotion: true },
    "resting",
    null,
  ],
  [
    "handoff with the flag off",
    recent,
    at("a2", 10, 220),
    { ...on, enabled: false },
    "resting",
    null,
  ],
  // resting
  ["same anchor re-publish", resting, at("a1", 10, 20), on, "resting", null],
  ["text shift only", resting, at("a1", 50, 44), on, "resting", null],
  ["idle fade keeps the anchor", resting, at("a1", 10, 20), on, "resting", null],
  ["new anchor", resting, at("a2", 300, 200), on, "gliding", "glide"],
  ["new anchor, no distance", resting, at("a2", 10, 20), on, "resting", null],
  ["long jump skips", resting, at("a2", 10, 1200), on, "resting", null],
  [
    "long jump limit 0 always glides",
    resting,
    at("a2", 10, 5000),
    { ...on, maxJumpPx: 0 },
    "gliding",
    "glide",
  ],
  ["reduced motion", resting, at("a2", 300, 200), { ...on, reducedMotion: true }, "resting", null],
  ["flag off", resting, at("a2", 300, 200), { ...on, enabled: false }, "resting", null],
  // A removal also clears any ghost still fading.
  ["removal", resting, { type: "departed", block: "one", at: 1000 }, on, "hidden", "cancel"],
  [
    "stale departure after a block move",
    resting,
    { type: "departed", block: "two", at: 1000 },
    on,
    "resting",
    null,
  ],
  ["settle while resting", resting, { type: "settled", anchor: "a1" }, on, "resting", null],
  ["motion reduced while resting", resting, { type: "motion-reduced" }, on, "resting", "cancel"],
  // gliding
  ["text shift mid-glide", gliding, at("a1", 12, 24), on, "gliding", null],
  ["new anchor mid-glide", gliding, at("a2", 300, 200), on, "gliding", "glide"],
  ["long jump mid-glide", gliding, at("a2", 10, 2000), on, "resting", "cancel"],
  [
    "reduced motion mid-glide",
    gliding,
    at("a2", 300, 200),
    { ...on, reducedMotion: true },
    "resting",
    "cancel",
  ],
  [
    "removal mid-glide",
    gliding,
    { type: "departed", block: "one", at: 1000 },
    on,
    "hidden",
    "cancel",
  ],
  ["motion reduced mid-glide", gliding, { type: "motion-reduced" }, on, "resting", "cancel"],
  ["glide finishes", gliding, { type: "settled", anchor: "a1" }, on, "resting", null],
  [
    "an interrupted glide's finish",
    gliding,
    { type: "settled", anchor: "a0" },
    on,
    "gliding",
    null,
  ],
];

for (const [name, state, event, config, next, effect] of cases)
  test(`glide transition: ${name}`, () => {
    const result = glideTransition(state, event, config);
    assert.equal(result.state.name, next);
    assert.equal(result.effect?.type ?? null, effect);
  });

test("a glide starts at the previous position and ends at the new one", () => {
  const { state, effect } = glideTransition(resting, at("a2", 300, 200, { height: 24 }), on);
  assert.deepEqual(effect, {
    type: "glide",
    anchor: "a2",
    from: { x: 10, y: 20, height: 20 },
    to: { x: 300, y: 200, height: 24 },
    interrupts: false,
  });
  // A move during a glide says so; only the edge knows where it has drawn the caret.
  assert.equal(glideTransition(gliding, at("a2", 300, 200), on).effect.interrupts, true);
  assert.deepEqual(state, {
    name: "gliding",
    anchor: "a2",
    block: "one",
    x: 300,
    y: 200,
    height: 24,
    from: { x: 10, y: 20, height: 20 },
  });
  // Text shifting the caret mid-glide moves the target, not the anchor.
  const shifted = glideTransition(state, at("a2", 320, 200, { height: 24 }), on).state;
  assert.equal(shifted.x, 320);
  assert.deepEqual(shifted.from, state.from);
  assert.deepEqual(glideTransition(shifted, { type: "settled", anchor: "a2" }, on).state, {
    name: "resting",
    anchor: "a2",
    block: "one",
    x: 320,
    y: 200,
    height: 24,
  });
  // A removal remembers the last position for a handoff.
  assert.deepEqual(glideTransition(resting, { type: "departed", block: "one", at: 5 }, on).state, {
    name: "hidden",
    last: { anchor: "a1", block: "one", x: 10, y: 20, height: 20, at: 5 },
  });
  assert.throws(() => glideTransition(resting, { type: "teleport" }, on), /Unknown/);
});

test("one Page's glide follows a caret between blocks in either measuring order", () => {
  let time = 0;
  const glide = createCaretGlide({
    settings: { enabled: true, maxJumpPx: 900 },
    now: () => time,
  });
  const caret = (anchor, y) => ({ session: "agent:a", anchor, x: 40, y, height: 20 });
  assert.deepEqual(glide.observe("one", [caret("a1", 100)]), []);
  // The new block measures first; the old block's departure comes after.
  const [effect] = glide.observe("two", [caret("a2", 400)]);
  assert.equal(effect.type, "glide");
  assert.deepEqual(effect.from, { x: 40, y: 100, height: 20 });
  assert.deepEqual(glide.observe("one", []), []);
  assert.equal(glide.state("agent:a").name, "gliding");
  glide.settle("agent:a", "a2");
  assert.equal(glide.state("agent:a").name, "resting");
  // The old block departs first, clearing its ghosts; the new block lands
  // within the handoff.
  assert.deepEqual(glide.observe("two", []), [{ session: "agent:a", type: "cancel" }]);
  time += 100;
  assert.equal(glide.observe("one", [caret("a3", 150)])[0]?.type, "glide");
  // Past the handoff, a reappearance is a first appearance.
  glide.release("one");
  time += GLIDE_HANDOFF_MS + 1;
  assert.deepEqual(glide.observe("two", [caret("a4", 600)]), []);
});

// A caret layer the way WordgardEditor draws it with the flag on, and a Web
// Animations stub: jsdom has no Element.animate. `progress` is the eased
// progress a browser reports through effect.getComputedTiming().
function layer() {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const root = document.body.appendChild(document.createElement("div"));
  root.className = "wordgard-caret-layer";
  const ghosts = root.appendChild(document.createElement("div"));
  ghosts.className = "agent-caret-ghosts";
  const caret = root.appendChild(document.createElement("span"));
  caret.className = "peer-caret";
  caret.dataset.glide = "agent:a";
  caret.style.setProperty("--peer-color", "rgb(1, 2, 3)");
  const animations = [];
  window.Element.prototype.animate = function (keyframes, options) {
    let finish, cancel;
    const animation = {
      target: this,
      keyframes,
      options,
      progress: 0,
      playState: "running",
      effect: { getComputedTiming: () => ({ progress: animation.progress }) },
      finished: new Promise((resolve, reject) => {
        finish = resolve;
        cancel = reject;
      }),
      finish() {
        animation.playState = "finished";
        finish();
      },
      cancel() {
        animation.playState = "idle";
        cancel(Error("AbortError"));
      },
    };
    animations.push(animation);
    return animation;
  };
  return { root, ghosts, caret, animations };
}

const settings = (extra = {}) => ({
  enabled: true,
  durationMs: 280,
  easing: "cubic-bezier(.2,.7,.2,1)",
  maxJumpPx: 900,
  ghostFadeMs: 600,
  ...extra,
});

// One block's editor: the Page's glide state, a runner on its caret layer,
// and the reduced-motion subscription WordgardEditor makes.
function block(config, reducedMotion$) {
  const dom = layer();
  const glide = createCaretGlide({ settings: config, now: () => 0, reducedMotion$ });
  const runner = createGlideRunner({
    layer: dom.root,
    ghostLayer: dom.ghosts,
    settings: config,
    onSettled: (session, anchor) => glide.settle(session, anchor),
    isCurrent: (effect) => glide.current(effect),
  });
  const subscription = glide.cancels$.subscribe((effects) => runner.run(effects));
  const observe = (carets) => runner.run(glide.observe("one", carets), { x: 5, y: 10 });
  // The editor's two steps: measure queues effects, React's commit flushes them.
  const measure = (carets) => runner.queue(glide.observe("one", carets), { x: 5, y: 10 });
  const commit = () => runner.flush();
  const glides = () => dom.animations.filter((animation) => animation.target === dom.caret);
  return { ...dom, glide, runner, subscription, observe, measure, commit, glides };
}
function drive(config, observations, reducedMotion = false) {
  const h = block(config, new BehaviorSubject(reducedMotion));
  for (const carets of observations) h.observe(carets);
  return h;
}
const caret = (anchor, x, y) => ({ session: "agent:a", anchor, x, y, height: 20 });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("with the flag on, a new anchor glides the caret and leaves a fading ghost", async () => {
  const h = drive(settings(), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  const glides = h.glides();
  assert.equal(glides.length, 1);
  assert.deepEqual(glides[0].keyframes, [
    { transform: "translate(-200px, -100px)" },
    { transform: "translate(0px, 0px)" },
  ]);
  assert.deepEqual(glides[0].options, { duration: 280, easing: "cubic-bezier(.2,.7,.2,1)" });
  const [ghost] = h.ghosts.querySelectorAll(".agent-caret-ghost");
  assert.ok(ghost, "a ghost marks the old position");
  // Article-relative (15, 30) less the layer offset (5, 10).
  assert.equal(ghost.style.left, "10px");
  assert.equal(ghost.style.top, "20px");
  assert.equal(ghost.style.height, "20px");
  assert.equal(ghost.style.getPropertyValue("--peer-color"), "rgb(1, 2, 3)");
  const fade = h.animations.find((animation) => animation.target === ghost);
  assert.deepEqual(fade.keyframes, [{ opacity: 0.3 }, { opacity: 0 }]);
  assert.equal(fade.options.duration, 600);
  assert.equal(h.glide.state("agent:a").name, "gliding");
  fade.finish();
  glides[0].finish();
  await flush();
  assert.equal(h.ghosts.querySelectorAll(".agent-caret-ghost").length, 0, "the ghost fades away");
  assert.equal(h.glide.state("agent:a").name, "resting");
  assert.equal(h.runner.running, 0);
  assert.equal(h.runner.ghosts, 0);
});

test("with the flag off, a new anchor neither glides nor leaves a ghost", () => {
  const h = drive(settings({ enabled: false }), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  assert.equal(h.animations.length, 0);
  assert.equal(h.ghosts.children.length, 0);
});

test("text shifting a caret neither glides nor leaves a ghost", () => {
  const h = drive(settings(), [
    [caret("a1", 15, 30)],
    [caret("a1", 95, 30)],
    [caret("a1", 95, 54)],
  ]);
  assert.equal(h.animations.length, 0);
  assert.equal(h.ghosts.children.length, 0);
});

test("reduced motion and long jumps neither glide nor leave a ghost", () => {
  const reduced = drive(settings(), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]], true);
  assert.equal(reduced.animations.length, 0);
  assert.equal(reduced.ghosts.children.length, 0);
  const far = drive(settings({ maxJumpPx: 100 }), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  assert.equal(far.animations.length, 0);
  assert.equal(far.ghosts.children.length, 0);
});

test("turning on reduced motion mid-glide snaps the caret to its anchor and removes the ghost", async () => {
  const preference = new BehaviorSubject(false);
  const h = block(settings(), preference);
  h.observe([caret("a1", 15, 30)]);
  h.observe([caret("a2", 215, 130)]);
  const [glide] = h.glides();
  const fade = h.animations.find((animation) => animation.target !== h.caret);
  assert.equal(h.ghosts.children.length, 1);
  // No new write: only the preference changes.
  preference.next(true);
  assert.equal(glide.playState, "idle", "the glide is cancelled");
  assert.equal(fade.playState, "idle", "the ghost's fade is cancelled");
  assert.equal(h.ghosts.children.length, 0, "the ghost is gone");
  assert.equal(h.runner.running, 0);
  assert.deepEqual(h.glide.state("agent:a"), {
    name: "resting",
    anchor: "a2",
    block: "one",
    x: 215,
    y: 130,
    height: 20,
  });
  await flush();
  assert.equal(h.glide.state("agent:a").name, "resting");
  // While reduced, the next write does not glide either.
  h.observe([caret("a3", 15, 330)]);
  assert.equal(h.glides().length, 1);
  assert.equal(h.ghosts.children.length, 0);
  // One media-query subscription per Page, shared by its blocks; it ends with them.
  h.subscription.unsubscribe();
  assert.equal(preference.observed, false);
});

test("an interrupted glide starts the next one from where the caret is drawn", () => {
  const h = block(settings(), new BehaviorSubject(false));
  h.observe([caret("a1", 15, 30)]);
  h.observe([caret("a2", 215, 130)]);
  // Halfway: layer (10, 20) -> (210, 120) has drawn the caret at (110, 70).
  h.glides()[0].progress = 0.5;
  h.observe([caret("a3", 15, 330)]);
  const glides = h.glides();
  assert.equal(glides.length, 2);
  assert.equal(glides[0].playState, "idle");
  // To layer (10, 320) from the drawn (110, 70), not from the old target (210, 120).
  assert.deepEqual(glides[1].keyframes[0], { transform: "translate(100px, -250px)" });
  const ghosts = [...h.ghosts.querySelectorAll(".agent-caret-ghost")];
  assert.equal(ghosts.length, 2);
  assert.equal(ghosts[1].style.left, "110px");
  assert.equal(ghosts[1].style.top, "70px");
});

test("a newer glide's caret owns the settle; a cancelled glide's late finish does not", async () => {
  const h = drive(settings(), [
    [caret("a1", 15, 30)],
    [caret("a2", 215, 130)],
    [caret("a3", 15, 330)],
  ]);
  const glides = h.glides();
  assert.equal(glides.length, 2);
  await flush();
  assert.equal(h.glide.state("agent:a").name, "gliding");
  assert.equal(h.glide.state("agent:a").anchor, "a3");
  glides[1].finish();
  await flush();
  assert.equal(h.glide.state("agent:a").name, "resting");
});

test("ghosts are removed when their caret goes away and when the editor unmounts", () => {
  const removed = drive(settings(), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  const fades = removed.animations.filter((animation) => animation.target !== removed.caret);
  assert.equal(removed.ghosts.children.length, 1);
  removed.observe([]);
  assert.equal(removed.ghosts.children.length, 0, "the caret left, so its ghost goes too");
  assert.equal(fades[0].playState, "idle");
  assert.equal(removed.runner.ghosts, 0);
  assert.equal(removed.glides()[0].playState, "idle");

  const unmounted = drive(settings(), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  unmounted.runner.dispose();
  assert.equal(unmounted.ghosts.children.length, 0);
  assert.equal(unmounted.runner.ghosts, 0);
  assert.equal(unmounted.runner.running, 0);
  assert.ok(unmounted.animations.every((animation) => animation.playState === "idle"));
});

test("zero duration jumps with a ghost; zero ghost glides without one", async () => {
  const jump = drive(settings({ durationMs: 0 }), [[caret("a1", 15, 30)], [caret("a2", 215, 130)]]);
  assert.equal(jump.glides().length, 0);
  assert.equal(jump.ghosts.children.length, 1);
  assert.equal(jump.glide.state("agent:a").name, "resting");
  const plain = drive(settings({ ghostFadeMs: 0 }), [
    [caret("a1", 15, 30)],
    [caret("a2", 215, 130)],
  ]);
  assert.equal(plain.glides().length, 1);
  assert.equal(plain.ghosts.children.length, 0);
});

test("reduced motion turned on before React commits drops the queued glide", () => {
  const preference = new BehaviorSubject(false);
  const h = block(settings(), preference);
  h.measure([caret("a1", 15, 30)]);
  h.commit();
  // Measurement queues the glide; the preference flips before the commit.
  h.measure([caret("a2", 215, 130)]);
  assert.equal(h.glide.state("agent:a").name, "gliding");
  preference.next(true);
  h.commit();
  assert.equal(h.animations.length, 0, "no glide or ghost animation starts");
  assert.equal(h.ghosts.children.length, 0);
  assert.equal(h.runner.running, 0);
  assert.deepEqual(h.glide.state("agent:a"), {
    name: "resting",
    anchor: "a2",
    block: "one",
    x: 215,
    y: 130,
    height: 20,
  });
});

test("a queued glide that a newer write replaced before the commit does not run", () => {
  const h = block(settings(), new BehaviorSubject(false));
  h.measure([caret("a1", 15, 30)]);
  h.commit();
  h.measure([caret("a2", 215, 130)]);
  h.measure([caret("a3", 15, 330)]);
  h.commit();
  const glides = h.glides();
  assert.equal(glides.length, 1, "only the newest write glides");
  assert.deepEqual(glides[0].keyframes[0], { transform: "translate(200px, -200px)" });
});

test("the reduced-motion stream reads the preference when subscribed, not when created", () => {
  const query = new EventTarget();
  query.matches = false;
  const preference$ = mediaMatches$(query);
  const seen = [];
  let subscription = preference$.subscribe((value) => seen.push(value));
  subscription.unsubscribe();
  // The preference changes while no editor is mounted.
  query.matches = true;
  subscription = preference$.subscribe((value) => seen.push(value));
  const change = new Event("change");
  change.matches = false;
  query.matches = false;
  query.dispatchEvent(change);
  subscription.unsubscribe();
  assert.deepEqual(seen, [false, true, false]);
});
