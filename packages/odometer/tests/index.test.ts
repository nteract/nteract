import { afterEach, describe, expect, it, vi } from "vitest";
import { createOdometer } from "../src/index";

function slotTexts(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-odometer-slot]")).map(
    (slot) => slot.dataset.char ?? "",
  );
}

function sizerTexts(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>(".nteract-odo-sizer")).map(
    (slot) => slot.textContent ?? "",
  );
}

describe("createOdometer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the visible value and exposes it for tests/accessibility", () => {
    const host = document.createElement("span");
    const odometer = createOdometer(host);

    odometer.update("999 rows");

    expect(host.dataset.value).toBe("999 rows");
    expect(host.getAttribute("aria-label")).toBe("999 rows");
    expect(slotTexts(host)).toEqual(["9", "9", "9", " ", "r", "o", "w", "s"]);
    expect(
      Array.from(host.querySelectorAll<HTMLElement>("[data-odometer-slot]")).every(
        (slot) => slot.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
  });

  it("keeps unchanged suffix slots stable and resizes slots for changing-length labels", () => {
    const host = document.createElement("span");
    const odometer = createOdometer(host);

    odometer.update("999 rows");
    const before = Array.from(host.querySelectorAll<HTMLElement>("[data-odometer-slot]"));

    odometer.update("1,000 rows");
    const after = Array.from(host.querySelectorAll<HTMLElement>("[data-odometer-slot]"));

    expect(host.dataset.value).toBe("1,000 rows");
    expect(slotTexts(host)).toEqual(["1", ",", "0", "0", "0", " ", "r", "o", "w", "s"]);
    expect(sizerTexts(host)).toEqual(["1", ",", "0", "0", "0", " ", "r", "o", "w", "s"]);
    expect(after.at(-4)).toBe(before.at(-4));
    expect(after.at(-3)).toBe(before.at(-3));
    expect(after.at(-2)).toBe(before.at(-2));
    expect(after.at(-1)).toBe(before.at(-1));
  });

  it("applies repeated updates immediately", () => {
    const host = document.createElement("span");
    const odometer = createOdometer(host);

    odometer.update("10 rows");
    odometer.update("11 rows");
    odometer.update("12 rows");

    expect(host.dataset.value).toBe("12 rows");
    expect(slotTexts(host)).toEqual(["1", "2", " ", "r", "o", "w", "s"]);
  });

  it("uses plain text when reduced motion is requested", () => {
    const host = document.createElement("span");
    const odometer = createOdometer(host, { reducedMotion: true });

    odometer.update("25 of 1,000 rows");

    expect(host.textContent).toBe("25 of 1,000 rows");
    expect(host.querySelector("[data-odometer-slot]")).toBeNull();
    expect(host.dataset.value).toBe("25 of 1,000 rows");
  });

  it("rebuilds animated slots after the reduced-motion preference turns off", () => {
    let reducedMotion = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reducedMotion })),
    );
    const host = document.createElement("span");
    const odometer = createOdometer(host);

    odometer.update("25 rows");
    expect(host.textContent).toBe("25 rows");
    expect(host.querySelector("[data-odometer-slot]")).toBeNull();

    reducedMotion = false;
    odometer.update("26 rows");

    expect(host.textContent).not.toBe("26 rows");
    expect(host.dataset.value).toBe("26 rows");
    expect(slotTexts(host)).toEqual(["2", "6", " ", "r", "o", "w", "s"]);
  });

  it("snaps wrapped digits back to canonical strip positions after transition", () => {
    const host = document.createElement("span");
    const odometer = createOdometer(host);

    odometer.update("19 rows");
    odometer.update("20 rows");

    const strips = host.querySelectorAll<HTMLElement>(".nteract-odo-strip");
    const wrappedZero = strips[1];
    expect(wrappedZero.style.transform).toBe("translateY(-13.2em)");

    wrappedZero.dispatchEvent(new Event("transitionend", { bubbles: true }));

    expect(wrappedZero.style.transform).toBe("translateY(-1.2em)");
  });
});
