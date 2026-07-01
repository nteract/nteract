import { Popover, PopoverTrigger, PopoverContent, Button, Label, Input } from "nteract-elements";
import { Settings2 } from "lucide-react";

export function CellSettingsPopover() {
  return (
    <div style={{ width: 320 }}>
      <Popover defaultOpen modal={false}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Settings2 />
            Cell settings
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <div className="grid gap-3">
            <div className="space-y-1">
              <h4 className="font-medium leading-none">Cell settings</h4>
              <p className="text-sm text-muted-foreground">Execution behavior for this cell.</p>
            </div>
            <div className="grid grid-cols-3 items-center gap-2">
              <Label htmlFor="timeout" className="text-sm">
                Timeout (s)
              </Label>
              <Input id="timeout" defaultValue="30" className="col-span-2 h-8" />
            </div>
            <div className="grid grid-cols-3 items-center gap-2">
              <Label htmlFor="retries" className="text-sm">
                Retries
              </Label>
              <Input id="retries" defaultValue="0" className="col-span-2 h-8" />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
