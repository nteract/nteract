import { createContext, type ReactNode, useContext } from "react";
import type { SavedWidgetModel, SavedWidgetModels } from "./widget-state";

const EMPTY_SAVED_WIDGET_MODELS: SavedWidgetModels = new Map();

const SavedWidgetStateContext = createContext<SavedWidgetModels>(EMPTY_SAVED_WIDGET_MODELS);

export interface SavedWidgetStateProviderProps {
  children: ReactNode;
  models?: SavedWidgetModels | null;
}

export function SavedWidgetStateProvider({ children, models }: SavedWidgetStateProviderProps) {
  return (
    <SavedWidgetStateContext.Provider value={models ?? EMPTY_SAVED_WIDGET_MODELS}>
      {children}
    </SavedWidgetStateContext.Provider>
  );
}

export function useSavedWidgetModels(): SavedWidgetModels {
  return useContext(SavedWidgetStateContext);
}

export function useSavedWidgetModel(modelId: string): SavedWidgetModel | undefined {
  return useSavedWidgetModels().get(modelId);
}
