export function installDocumentThemeSync(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const isDark = mediaQuery.matches;
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  };

  apply();
  mediaQuery.addEventListener("change", apply);
}
