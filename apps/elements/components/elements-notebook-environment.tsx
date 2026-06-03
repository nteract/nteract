"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import {
  getElementsNotebookScenario,
  type ElementsNotebookOutputState,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
  type ElementsNotebookVariable,
  type ElementsNotebookRenderer,
  type ElementsNotebookNotice,
} from "@/components/notebook-scenarios";

export interface ElementsNotebookEnvironmentModel {
  scenario: ElementsNotebookScenario;
  capabilities: ElementsNotebookScenario["capabilities"];
  rail: {
    activePanelId: NotebookRailPanelId;
    collapsed: boolean;
    outlineItemCount: number;
    packageCount: number;
  };
  document: {
    cellCount: number;
    selectedCellId: string | null;
    focusedCellId: string | null;
    viewModel: ElementsNotebookScenario["viewModel"];
  };
  outputs: ElementsNotebookOutputState;
  notices: readonly ElementsNotebookNotice[];
  runtime: {
    label: string;
    packageSummary: string;
    variables: readonly ElementsNotebookVariable[];
    renderers: readonly ElementsNotebookRenderer[];
  };
  actions: {
    eventLog: readonly string[];
    setActivePanel: (panelId: NotebookRailPanelId) => void;
    setRailCollapsed: (collapsed: boolean) => void;
    selectCell: (cellId: string | null) => void;
    focusCell: (cellId: string | null) => void;
    recordHostAction: (label: string) => void;
    clearEventLog: () => void;
  };
}

const ElementsNotebookEnvironmentContext = createContext<ElementsNotebookEnvironmentModel | null>(
  null,
);

export interface ElementsNotebookEnvironmentProps {
  children: ReactNode;
  initialActivePanelId?: NotebookRailPanelId;
  initialFocusedCellId?: string | null;
  initialRailCollapsed?: boolean;
  initialSelectedCellId?: string | null;
  scenarioId: ElementsNotebookScenarioId;
}

export function ElementsNotebookEnvironment({
  children,
  initialActivePanelId = "outline",
  initialFocusedCellId = null,
  initialRailCollapsed = false,
  initialSelectedCellId = null,
  scenarioId,
}: ElementsNotebookEnvironmentProps) {
  const scenario = getElementsNotebookScenario(scenarioId);
  const [activePanelId, setActivePanelId] = useState<NotebookRailPanelId>(initialActivePanelId);
  const [collapsed, setCollapsed] = useState(initialRailCollapsed);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(initialSelectedCellId);
  const [focusedCellId, setFocusedCellId] = useState<string | null>(initialFocusedCellId);
  const [eventLog, setEventLog] = useState<readonly string[]>([]);

  const model = useMemo<ElementsNotebookEnvironmentModel>(
    () => ({
      scenario,
      capabilities: scenario.capabilities,
      rail: {
        activePanelId,
        collapsed,
        outlineItemCount: scenario.viewModel.outlineItems.length,
        packageCount: scenario.viewModel.packages.sections.reduce(
          (count, section) => count + section.dependencies.length,
          0,
        ),
      },
      document: {
        cellCount: scenario.cells.length,
        selectedCellId,
        focusedCellId,
        viewModel: scenario.viewModel,
      },
      outputs: scenario.outputState,
      notices: scenario.notices,
      runtime: {
        label: scenario.runtimeLabel,
        packageSummary: scenario.packageSummary,
        variables: scenario.variables,
        renderers: scenario.renderers,
      },
      actions: {
        eventLog,
        setActivePanel: (panelId) => {
          setActivePanelId(panelId);
          setEventLog((items) => [`rail:${panelId}`, ...items].slice(0, 6));
        },
        setRailCollapsed: (nextCollapsed) => {
          setCollapsed(nextCollapsed);
          setEventLog((items) =>
            [`rail:${nextCollapsed ? "collapsed" : "expanded"}`, ...items].slice(0, 6),
          );
        },
        selectCell: (cellId) => {
          setSelectedCellId(cellId);
          setEventLog((items) => [`select:${cellId ?? "none"}`, ...items].slice(0, 6));
        },
        focusCell: (cellId) => {
          setFocusedCellId(cellId);
          setEventLog((items) => [`focus:${cellId ?? "none"}`, ...items].slice(0, 6));
        },
        recordHostAction: (label) => {
          setEventLog((items) => [`host:${label}`, ...items].slice(0, 6));
        },
        clearEventLog: () => setEventLog([]),
      },
    }),
    [activePanelId, collapsed, eventLog, focusedCellId, scenario, selectedCellId],
  );

  return (
    <ElementsNotebookEnvironmentContext.Provider value={model}>
      {children}
    </ElementsNotebookEnvironmentContext.Provider>
  );
}

export function useElementsNotebookEnvironment() {
  const environment = useContext(ElementsNotebookEnvironmentContext);
  if (!environment) {
    throw new Error(
      "useElementsNotebookEnvironment must be used within ElementsNotebookEnvironment.",
    );
  }
  return environment;
}
