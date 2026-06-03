export { NotebookView, type NotebookViewProps } from "./components/NotebookView";
export {
  PresenceValueProvider,
  type PresenceContextValue,
} from "./contexts/PresenceContext";
export { CrdtBridgeProvider } from "./hooks/useCrdtBridge";
export { createNotebookController } from "./lib/notebook-controller";
export { startCursorDispatch } from "./lib/cursor-registry";
export { setLoggerHost } from "./lib/logger";
export { emitBroadcast, emitPresence } from "./lib/notebook-frame-bus";
