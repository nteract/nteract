import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small uppercase label used throughout the Elements catalog for card
 * eyebrows, table column headers, and inline metadata labels. One
 * component so the catalog stops drifting across three sizes
 * (text-[10px]/text-[11px]/text-xs), four tracking values, and two
 * color tokens. The default is the dominant convention: 11px, medium,
 * 0.08em tracking, muted. Pass `className` to override color or sizing
 * where a label genuinely needs to differ (e.g. a foreground label).
 * Use `as` to keep semantic elements (`dt` inside a `<dl>`, `h3`/`h4`
 * for section eyebrows) instead of the default `span`.
 */
export function Eyebrow({
  as: Tag = "span",
  children,
  className,
}: {
  as?: ElementType;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * The card chrome shared across Elements pages: a bordered card with an
 * optional header strip (icon + title + detail or mono source + trailing
 * badge), then a body. Replaces three local copies (SurfaceFrame,
 * RendererCard, SectionHeader) and the ad-hoc inline variants.
 *
 * Header variants, all from this one component:
 * - icon + title + detail (pass `detail`)
 * - icon + title + mono source + trailing badge (pass `source` + `badge`)
 * - icon + title only (pass neither `detail` nor `source`)
 * - no header (omit `icon` and `title`); use for cards that own their own
 *   top content
 *
 * The icon renders as an inline `size-4` glyph in the muted color. For the
 * boxed-icon look (a size-8 swatch), pass `iconSlot` instead of `icon`.
 */
export function SurfaceFrame({
  title,
  icon,
  iconSlot,
  detail,
  source,
  badge,
  headerClassName,
  bodyClassName,
  className,
  children,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  iconSlot?: ReactNode;
  detail?: ReactNode;
  source?: ReactNode;
  badge?: ReactNode;
  headerClassName?: string;
  bodyClassName?: string;
  className?: string;
  children?: ReactNode;
}) {
  const hasHeader = Boolean(title || icon || iconSlot || detail || source || badge);
  return (
    <section
      className={cn("overflow-hidden rounded-lg border border-fd-border bg-fd-card", className)}
    >
      {hasHeader ? (
        <div className={cn("border-b border-fd-border p-4", headerClassName)}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              {iconSlot ? (
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-muted">
                  {iconSlot}
                </div>
              ) : null}
              {icon ? (
                <span className="mt-0.5 flex size-4 shrink-none items-center text-fd-muted-foreground">
                  {icon}
                </span>
              ) : null}
              <div className="min-w-0">
                {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
                {detail ? (
                  <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{detail}</p>
                ) : null}
                {source ? (
                  <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                    {source}
                  </div>
                ) : null}
              </div>
            </div>
            {badge ? <div className="shrink-0">{badge}</div> : null}
          </div>
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
