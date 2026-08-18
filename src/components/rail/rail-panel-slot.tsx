import { createContext, useContext, type ReactNode } from "react";

/**
 * Host-owned DOM node that an expanded rail panel renders into.
 *
 * The rail's icon strip stays where the host puts it (far left of the page
 * content). When a host provides a slot node, the expandable panel portals into
 * it instead of sitting inside the rail `aside`, so the panel can open below the
 * utility bar and beside the notebook content while the strip keeps full height.
 *
 * `null` (the default) keeps the panel inside the rail — standalone rails and
 * fixtures need no host wiring.
 */
const RailPanelSlotContext = createContext<HTMLElement | null>(null);

export function useRailPanelSlot(): HTMLElement | null {
  return useContext(RailPanelSlotContext);
}

export function RailPanelSlotProvider({
  node,
  children,
}: {
  node: HTMLElement | null;
  children: ReactNode;
}) {
  return <RailPanelSlotContext.Provider value={node}>{children}</RailPanelSlotContext.Provider>;
}
