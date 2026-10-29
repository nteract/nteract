import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Table2, Rows3, Columns3, Trash2 } from "lucide-react";
import { Command } from "wordgard/command";
import { addRow, addColumn, deleteRow, deleteColumn } from "wordgard/table";
import { insertTable, selectedTable } from "./wordgard-tables.mjs";

const actions = [
  ["Insert row above", Rows3, addRow, "before"],
  ["Insert row below", Rows3, addRow, "after"],
  ["Delete row", Trash2, deleteRow],
  ["Insert column left", Columns3, addColumn, "before"],
  ["Insert column right", Columns3, addColumn, "after"],
  ["Delete column", Trash2, deleteColumn],
];

export function TableMenu({ editor, inTable, editable, onError }) {
  const button = useRef(null),
    menu = useRef(null);
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState(null);
  const [rows, setRows] = useState("3"),
    [columns, setColumns] = useState("3");
  const close = (focus = false) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  useEffect(() => {
    setOpen(false);
  }, [inTable, editable]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, innerWidth - 252)),
          top: Math.max(8, Math.min(rect.bottom + 6, innerHeight - 300)),
        });
    };
    place();
    const outside = (event) => {
      if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);

    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const visible = open && position !== null;
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector("button,input")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  function run(command, value) {
    try {
      // Re-check current permissions and selection after any remote update.
      if (!editor?.editable || !selectedTable(editor.state)) return close();
      Command.dispatch(editor, command, value);
      close();
      editor.focus();
    } catch (error) {
      onError(error);
    }
  }
  function keys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    if (inTable && event.key === "Tab") close();
    if (!inTable || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.current.querySelectorAll("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
    ]?.focus();
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`toolbar-button${inTable ? " is-active" : ""}`}
        aria-label={inTable ? "Table options" : "Insert table"}
        title={inTable ? "Table options" : "Insert table"}
        aria-haspopup={inTable ? "menu" : "dialog"}
        aria-expanded={open}
        disabled={!editable}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Table2 size={18} aria-hidden="true" />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menu}
            className="pages-table-menu"
            style={position}
            role={inTable ? "menu" : "dialog"}
            aria-label={inTable ? "Table options" : "Insert table"}
            onKeyDown={keys}
          >
            {inTable ? (
              actions.map(([label, Icon, command, value], index) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className={`${index === 3 ? "table-menu-divider " : ""}${label.startsWith("Delete") ? "table-menu-delete" : ""}`}
                  onClick={() => run(command, value)}
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </button>
              ))
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  // Portals still bubble through React parents, including a
                  // comment composer form. Inserting a table must not send it.
                  event.stopPropagation();
                  try {
                    if (insertTable(editor, Number(columns), Number(rows))) {
                      close();
                      editor.focus();
                    }
                  } catch (error) {
                    onError(error);
                  }
                }}
              >
                <label>
                  Columns
                  <input
                    aria-label="Columns"
                    type="number"
                    min="1"
                    max="20"
                    value={columns}
                    onChange={(event) => setColumns(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Rows
                  <input
                    aria-label="Rows"
                    type="number"
                    min="1"
                    max="20"
                    value={rows}
                    onChange={(event) => setRows(event.target.value)}
                    required
                  />
                </label>
                <button type="submit">Insert table</button>
              </form>
            )}
          </div>,
          button.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}
