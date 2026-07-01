import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Label,
  Input,
  Button,
} from "nteract-elements";

export function NotebookSettingsSheet() {
  return (
    <Sheet defaultOpen modal={false}>
      <SheetContent side="right" className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Notebook settings</SheetTitle>
          <SheetDescription>Applies to this notebook document only.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          <div className="grid gap-1.5">
            <Label htmlFor="nb-name">Name</Label>
            <Input id="nb-name" defaultValue="feature-engineering.ipynb" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nb-kernel">Default kernel</Label>
            <Input id="nb-kernel" defaultValue="Python 3.12" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nb-autosave">Autosave interval (s)</Label>
            <Input id="nb-autosave" defaultValue="15" />
          </div>
        </div>
        <div className="mt-auto flex justify-end gap-2 p-4">
          <Button variant="outline" size="sm">
            Cancel
          </Button>
          <Button size="sm">Save</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
