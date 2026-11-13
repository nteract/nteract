// The chart-height store: one localStorage entry, keyed by account, Page and
// view, bounded, and tolerant of storage that is corrupt, blocked or absent.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VIEW_HEIGHTS,
  MAX_VIEW_HEIGHT_PX,
  VIEW_HEIGHTS_KEY,
  viewHeight,
  viewHeights,
} from "./view-heights.mjs";

function memoryBrowser(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => {
        writes.push(key);
        values.set(key, String(value));
      },
      removeItem: (key) => void values.delete(key),
    },
  };
}
const stored = (browser) => JSON.parse(browser.values.get(VIEW_HEIGHTS_KEY));
const PAGE = "0b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER_PAGE = "1b9f2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

test("the key is the stored contract", () => {
  assert.equal(VIEW_HEIGHTS_KEY, "nteract.pages.view-heights");
});

test("a height round-trips in whole px, per account, Page and view", () => {
  const browser = memoryBrowser();
  const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
  assert.equal(mine.read("view_sales"), null);
  assert.equal(mine.write("view_sales", 371.6), 372);
  assert.equal(mine.read("view_sales"), 372);
  assert.equal(viewHeights(browser, { account: "ada", pageId: PAGE }).read("view_sales"), 372);
  assert.equal(viewHeights(browser, { account: "bo", pageId: PAGE }).read("view_sales"), null);
  assert.equal(
    viewHeights(browser, { account: "ada", pageId: OTHER_PAGE }).read("view_sales"),
    null,
  );
  assert.equal(mine.read("view_costs"), null);
  mine.write("view_sales", 400);
  assert.deepEqual(stored(browser), { v: 1, heights: [["ada", PAGE, "view_sales", 400]] });
});

test("rewriting the newest height unchanged doesn't touch storage", () => {
  const browser = memoryBrowser();
  const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
  mine.write("view_sales", 372);
  mine.write("view_sales", 372.2);
  assert.equal(browser.writes.length, 1);
});

test("an unknown account or Page remembers nothing", () => {
  const browser = memoryBrowser();
  assert.equal(viewHeights(browser, { account: null, pageId: PAGE }), null);
  assert.equal(viewHeights(browser, { account: "ada", pageId: "" }), null);
  assert.equal(viewHeights(browser), null);
  assert.equal(browser.values.size, 0);
});

test("heights that aren't a chart's are refused", () => {
  assert.equal(viewHeight(0), null);
  assert.equal(viewHeight(-4), null);
  assert.equal(viewHeight(Number.NaN), null);
  assert.equal(viewHeight("300"), null);
  assert.equal(viewHeight(MAX_VIEW_HEIGHT_PX + 1), null);
  const browser = memoryBrowser();
  const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
  assert.equal(mine.write("view_sales", 0), null);
  assert.equal(mine.write("", 300), null);
  assert.equal(browser.values.size, 0);
});

test("the entry holds at most MAX_VIEW_HEIGHTS rows, dropping the oldest written", () => {
  const browser = memoryBrowser();
  const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
  for (let i = 0; i < MAX_VIEW_HEIGHTS + 5; i++) mine.write(`view_${i}`, 100 + i);
  const rows = stored(browser).heights;
  assert.equal(rows.length, MAX_VIEW_HEIGHTS);
  assert.equal(mine.read("view_0"), null);
  assert.equal(mine.read("view_4"), null);
  assert.equal(mine.read("view_5"), 105);
  // Writing an old view again makes it the newest.
  mine.write("view_5", 999);
  assert.deepEqual(stored(browser).heights.at(-1), ["ada", PAGE, "view_5", 999]);
  assert.equal(stored(browser).heights.length, MAX_VIEW_HEIGHTS);
});

test("a corrupt or foreign entry reads as nothing and is replaced on write", () => {
  for (const raw of [
    "{not json",
    JSON.stringify({ v: 2, heights: [["ada", PAGE, "view_sales", 300]] }),
    JSON.stringify({ v: 1, heights: "nope" }),
    JSON.stringify(null),
  ]) {
    const browser = memoryBrowser({ [VIEW_HEIGHTS_KEY]: raw });
    const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
    assert.equal(mine.read("view_sales"), null, raw);
    mine.write("view_sales", 320);
    assert.deepEqual(stored(browser), { v: 1, heights: [["ada", PAGE, "view_sales", 320]] });
  }
  // Bad rows drop; good ones stay.
  const browser = memoryBrowser({
    [VIEW_HEIGHTS_KEY]: JSON.stringify({
      v: 1,
      heights: [
        ["ada", PAGE, "view_a", 300],
        ["ada", PAGE, "view_b", 300.5],
        ["ada", PAGE, "view_c", -1],
        ["ada", PAGE, 7, 300],
        "row",
        ["ada", PAGE, "view_d", 310],
      ],
    }),
  });
  const mine = viewHeights(browser, { account: "ada", pageId: PAGE });
  assert.equal(mine.read("view_a"), 300);
  assert.equal(mine.read("view_b"), null);
  assert.equal(mine.read("view_d"), 310);
});

test("storage that throws on read or write, or is missing, still answers", () => {
  const blocked = {
    get localStorage() {
      throw new Error("blocked");
    },
  };
  const fromBlocked = viewHeights(blocked, { account: "ada", pageId: PAGE });
  assert.equal(fromBlocked.read("view_sales"), null);
  assert.equal(fromBlocked.write("view_sales", 300), 300);

  const throwing = {
    localStorage: {
      getItem: () => {
        throw new Error("read refused");
      },
      setItem: () => {
        throw new Error("quota");
      },
    },
  };
  const fromThrowing = viewHeights(throwing, { account: "ada", pageId: PAGE });
  assert.equal(fromThrowing.read("view_sales"), null);
  assert.equal(fromThrowing.write("view_sales", 300), 300);

  const full = memoryBrowser();
  full.localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert.equal(viewHeights(full, { account: "ada", pageId: PAGE }).write("view_sales", 300), 300);

  for (const browser of [undefined, {}, { localStorage: null }]) {
    const none = viewHeights(browser, { account: "ada", pageId: PAGE });
    assert.equal(none.read("view_sales"), null);
    assert.equal(none.write("view_sales", 300), 300);
  }
});
