import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia; the dark-mode/color-theme hooks read it. Provide a
// no-op default (light, no listeners) so theme-aware components render in tests.
// Individual tests may still override this to simulate dark mode.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
