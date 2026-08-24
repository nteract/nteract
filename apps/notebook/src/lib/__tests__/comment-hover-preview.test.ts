import { afterEach, describe, expect, it } from "vite-plus/test";
import { RAIL_TAKEOVER_MEDIA_QUERY } from "@/components/rail";
import { commentHoverPreviewsEnabled } from "../comment-highlight-extension";

const originalMatchMedia = window.matchMedia;

function stubMatchMedia(matches: boolean): string[] {
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return { matches } as MediaQueryList;
  }) as typeof window.matchMedia;
  return queries;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("commentHoverPreviewsEnabled", () => {
  it("stays off when the notebook and the Discussions panel fit side by side", () => {
    const queries = stubMatchMedia(false);
    expect(commentHoverPreviewsEnabled()).toBe(false);
    expect(queries).toEqual([RAIL_TAKEOVER_MEDIA_QUERY]);
  });

  it("turns on below the rail takeover width, where the panel covers the notebook", () => {
    stubMatchMedia(true);
    expect(commentHoverPreviewsEnabled()).toBe(true);
  });

  it("stays off when media queries are unavailable", () => {
    (window as { matchMedia?: typeof window.matchMedia }).matchMedia = undefined;
    expect(commentHoverPreviewsEnabled()).toBe(false);
  });
});