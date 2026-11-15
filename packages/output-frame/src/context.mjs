// A small subset of the notebook embed's HostContext shape. Preference
// resolution stays with the embedding product: "system" is never a wire value.
export const OUTPUT_STYLE_VARIABLES = Object.freeze([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--radius",
  "--output-ui-font",
  "--output-mono-font",
  "--output-document-font",
]);

export function normalizeHostContext(context) {
  if (context?.theme !== "light" && context?.theme !== "dark")
    throw Error("The host must resolve its theme to light or dark.");
  const variables = Object.fromEntries(
    OUTPUT_STYLE_VARIABLES.flatMap((name) => {
      const value = context.styles?.variables?.[name];
      if (value === undefined || value === "") return [];
      if (typeof value !== "string" || value.length > 512)
        throw Error(`Invalid style token ${name}.`);
      return [[name, value]];
    }),
  );
  return Object.freeze({
    theme: context.theme,
    styles: Object.freeze({ variables: Object.freeze(variables) }),
  });
}

/** Read only public design tokens, never copy the host's whole stylesheet. */
export function readHostContext(element, theme) {
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return normalizeHostContext({
    theme,
    styles: {
      variables: Object.fromEntries(
        OUTPUT_STYLE_VARIABLES.map((name) => [name, style.getPropertyValue(name).trim()]),
      ),
    },
  });
}

export function applyHostContext(document, context) {
  context = normalizeHostContext(context);
  const root = document.documentElement;
  root.dataset.theme = context.theme;
  root.classList.toggle("dark", context.theme === "dark");
  root.classList.toggle("light", context.theme === "light");
  root.style.colorScheme = context.theme;
  for (const name of OUTPUT_STYLE_VARIABLES) {
    const value = context.styles.variables[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  return context;
}
