import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  Button,
} from "nteract-elements";

export function ConfirmRestart() {
  return (
    <Dialog defaultOpen modal={false}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart kernel?</DialogTitle>
          <DialogDescription>
            This clears every variable held in memory. Outputs already written
            to the notebook are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="destructive">Restart</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
