import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Asks what happens to a prompt's answer cells when the prompt is deleted.
 * Kept answers stay as ordinary cells.
 */
export function PromptDeleteDialog({
  open,
  answerCount,
  onDeleteAll,
  onKeepAnswers,
  onCancel,
}: {
  open: boolean;
  /** Number of answer cells when the dialog opened. */
  answerCount: number;
  onDeleteAll: () => void;
  onKeepAnswers: () => void;
  onCancel: () => void;
}) {
  const question =
    answerCount === 1
      ? "This prompt has an answer cell. Delete it too?"
      : `This prompt has ${answerCount} answer cells. Delete them too?`;
  return (
    <Dialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} data-testid="prompt-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete prompt</DialogTitle>
          <DialogDescription>
            {question} Kept answers stay in the notebook as ordinary cells.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap gap-2 sm:space-x-0">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onKeepAnswers}>
            Keep answers
          </Button>
          <Button variant="destructive" onClick={onDeleteAll}>
            Delete all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
