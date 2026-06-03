import { useCallback } from "react";
import { useNotebookHost } from "@nteract/notebook-host";
import {
  PoolErrorBanner as SharedPoolErrorBanner,
  type PoolErrorBannerProps as SharedPoolErrorBannerProps,
} from "@/components/notebook/PoolErrorBanner";

export type { PoolErrorBannerProps, PoolErrorDetails } from "@/components/notebook/PoolErrorBanner";

export function PoolErrorBanner(props: SharedPoolErrorBannerProps) {
  const host = useNotebookHost();
  const openSettings = useCallback(() => {
    host.settings.openWindow().catch((e) => {
      console.error("Failed to open settings:", e);
    });
  }, [host]);

  return <SharedPoolErrorBanner {...props} onOpenSettings={props.onOpenSettings ?? openSettings} />;
}
