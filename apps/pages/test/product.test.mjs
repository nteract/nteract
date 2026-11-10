import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCT_NAME, tabTitle } from "../shared/product.mjs";

test("the product is called Pages in headers and tab titles", () => {
  assert.equal(PRODUCT_NAME, "Pages");
  assert.equal(tabTitle("Roadmap"), "Roadmap · Pages");
  assert.equal(tabTitle(""), "Pages");
  assert.equal(tabTitle(undefined), "Pages");
});
