import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
  Button,
} from "nteract-elements";
import { Play, Copy, Trash2, MoveUp, MoveDown } from "lucide-react";

export function CellActionsMenu() {
  return (
    <div style={{ width: 260 }}>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Cell actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Cell #4</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <Play />
            Run cell
            <DropdownMenuShortcut>⌘⏎</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Copy />
            Duplicate
            <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <MoveUp />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem>
            <MoveDown />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked>Show output</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <Trash2 />
            Delete cell
            <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
