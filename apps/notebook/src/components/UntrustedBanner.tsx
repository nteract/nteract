import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";

interface UntrustedBannerProps {
  onReviewClick: () => void;
}

export function UntrustedBanner({ onReviewClick }: UntrustedBannerProps) {
  return (
    <NotebookNotice
      tone="warning"
      icon={<ShieldAlert className="h-4 w-4" />}
      actions={
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-xs"
          data-testid="review-dependencies-button"
          onClick={onReviewClick}
        >
          Review Dependencies
        </Button>
      }
    >
      This notebook has dependencies that need approval before the kernel can start.
    </NotebookNotice>
  );
}
