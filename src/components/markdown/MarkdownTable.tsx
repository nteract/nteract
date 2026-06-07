import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import {
  markdownTableCellClassName,
  markdownTableClassName,
  markdownTableHeadClassName,
  markdownTableHeaderCellClassName,
  markdownTableRowClassName,
  markdownTableWrapperClassName,
} from "./markdown-typography";

export function MarkdownTableFrame({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn(markdownTableWrapperClassName, className)} {...props}>
      {children}
    </div>
  );
}

export function MarkdownTableElement({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return <table className={cn(markdownTableClassName, className)} {...props} />;
}

export function MarkdownTableHead({ className, ...props }: ComponentPropsWithoutRef<"thead">) {
  return <thead className={cn(markdownTableHeadClassName, className)} {...props} />;
}

export function MarkdownTableBody({ className, ...props }: ComponentPropsWithoutRef<"tbody">) {
  return <tbody className={className} {...props} />;
}

export function MarkdownTableHeaderRow(props: ComponentPropsWithoutRef<"tr">) {
  return <tr {...props} />;
}

export function MarkdownTableRow({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return <tr className={cn(markdownTableRowClassName, className)} {...props} />;
}

export function MarkdownTableHeaderCell({ className, ...props }: ComponentPropsWithoutRef<"th">) {
  return <th className={cn(markdownTableHeaderCellClassName, className)} {...props} />;
}

export function MarkdownTableCell({ className, ...props }: ComponentPropsWithoutRef<"td">) {
  return <td className={cn(markdownTableCellClassName, className)} {...props} />;
}
