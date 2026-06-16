import type { ConnectionStatus } from "runtimed";

export function markdownConnectionCopy(
  status: ConnectionStatus,
  bodyReady: boolean,
): string | null {
  if (!bodyReady) {
    return "Syncing Markdown document body.";
  }
  switch (status) {
    case "connecting":
      return null;
    case "reconnecting":
      return "Reconnecting to the live Markdown document.";
    case "offline":
      return "Markdown document is offline. Local changes will wait for reconnection.";
    case "online":
      return null;
  }
}
