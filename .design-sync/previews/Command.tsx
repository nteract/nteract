import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "nteract-elements";
import { Play, Plus, Search, Settings } from "lucide-react";

export function CommandPalette() {
  return (
    <Command
      className="rounded-lg border shadow-md"
      style={{ maxWidth: 380 }}
    >
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Notebook">
          <CommandItem>
            <Play />
            Run all cells
            <CommandShortcut>⌘↵</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Plus />
            Insert cell below
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Workspace">
          <CommandItem>
            <Search />
            Search notebooks
          </CommandItem>
          <CommandItem>
            <Settings />
            Open settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
