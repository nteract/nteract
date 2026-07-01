import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuShortcut,
} from "nteract-elements";
import { Play, Copy, Trash2, SquareCode } from "lucide-react";

export function CellContextMenu() {
  return (
    <div style={{ width: 300 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed border-input bg-muted/40 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <SquareCode className="h-4 w-4" />
              Right-click cell #2 to open actions
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>Cell #2</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem>
            <Play />
            Run cell
            <ContextMenuShortcut>⌘⏎</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>
            <Copy />
            Duplicate
          </ContextMenuItem>
          <ContextMenuCheckboxItem checked>Show output</ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">
            <Trash2 />
            Delete cell
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
