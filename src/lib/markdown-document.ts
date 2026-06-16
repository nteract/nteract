import {
  canRenderMarkdownProjectionInHost,
  projectMarkdownPlan,
  resolveMarkdownProjection,
  type MarkdownProjectionAnchor,
  type MarkdownProjectionPlan,
} from "./markdown-projection";

export type MarkdownDocumentAccessLevel = "owner" | "editor" | "viewer" | "none";
export type MarkdownDocumentMode = "view" | "edit";
export type MarkdownDocumentRepresentation = "rendered" | "source" | "split";

export interface MarkdownDocumentSnapshot {
  id: string;
  title: string;
  body: string;
  access: MarkdownDocumentAccessLevel;
  publishedRevisionId?: string | null;
  updatedAt?: string | null;
}

export interface MarkdownDocumentProjectionInput {
  id: string;
  title?: string | null;
  body?: string | null;
  markdownPlan?: MarkdownProjectionPlan | null;
  access?: MarkdownDocumentAccessLevel | null;
  requestedMode?: MarkdownDocumentMode | null;
  requestedRepresentation?: MarkdownDocumentRepresentation | null;
  publishedRevisionId?: string | null;
  updatedAt?: string | null;
}

export interface MarkdownDocumentRepresentationOption {
  id: MarkdownDocumentRepresentation;
  label: string;
  title: string;
  disabled: boolean;
}

export interface MarkdownDocumentRepresentationProjection {
  active: MarkdownDocumentRepresentation;
  sourceEditable: boolean;
  options: readonly MarkdownDocumentRepresentationOption[];
}

export interface MarkdownDocumentOutlineItem {
  id: string;
  title: string;
  level: number;
  anchor: string;
  href: string;
  sourceSpanUtf16: readonly [number, number];
  blockId: string;
}

export interface MarkdownDocumentHeadingAnchor {
  itemId: string;
  title: string;
  level: number;
  anchor: string;
  headingAnchorId: string;
}

export interface MarkdownDocumentProjection {
  id: string;
  title: string;
  body: string;
  access: MarkdownDocumentAccessLevel;
  mode: MarkdownDocumentMode;
  canEdit: boolean;
  canShare: boolean;
  canPublish: boolean;
  isPublished: boolean;
  publishedRevisionId: string | null;
  updatedAt: string | null;
  markdownPlan: MarkdownProjectionPlan | null;
  canRenderInHost: boolean;
  representation: MarkdownDocumentRepresentationProjection;
  outlineItems: readonly MarkdownDocumentOutlineItem[];
  headingAnchors: readonly MarkdownDocumentHeadingAnchor[];
}

export function projectMarkdownDocument(
  input: MarkdownDocumentProjectionInput,
): MarkdownDocumentProjection {
  const access = normalizeMarkdownDocumentAccess(input.access);
  const body = input.body ?? "";
  const canEdit = access === "owner" || access === "editor";
  const mode = canEdit ? (input.requestedMode ?? "view") : "view";
  const markdownPlan = input.markdownPlan
    ? resolveMarkdownProjection(input.markdownPlan, body)
    : projectMarkdownPlan(body);
  const publishedRevisionId = input.publishedRevisionId ?? null;
  const canRenderInHost = canRenderMarkdownProjectionInHost(markdownPlan);

  const outlineItems = markdownPlan ? projectMarkdownDocumentOutline(markdownPlan) : [];

  return {
    id: input.id,
    title: normalizeMarkdownDocumentTitle(input.title, input.id),
    body,
    access,
    mode,
    canEdit,
    canShare: access === "owner",
    canPublish: access === "owner",
    isPublished: publishedRevisionId !== null,
    publishedRevisionId,
    updatedAt: input.updatedAt ?? null,
    markdownPlan,
    canRenderInHost,
    representation: projectMarkdownDocumentRepresentation({
      canEdit,
      canRender: canRenderInHost,
      mode,
      requestedRepresentation: input.requestedRepresentation,
    }),
    outlineItems,
    headingAnchors: markdownDocumentHeadingAnchors(outlineItems),
  };
}

export function projectMarkdownDocumentRepresentation({
  canEdit,
  canRender,
  mode,
  requestedRepresentation,
}: {
  canEdit: boolean;
  canRender: boolean;
  mode: MarkdownDocumentMode;
  requestedRepresentation?: MarkdownDocumentRepresentation | null;
}): MarkdownDocumentRepresentationProjection {
  const sourceEditable = canEdit && mode === "edit";
  const defaultRepresentation: MarkdownDocumentRepresentation =
    mode === "edit" && sourceEditable ? "source" : "rendered";
  const requested =
    requestedRepresentation === "source" ||
    requestedRepresentation === "rendered" ||
    requestedRepresentation === "split"
      ? requestedRepresentation
      : defaultRepresentation;
  const active: MarkdownDocumentRepresentation =
    requested === "split" || (requested === "rendered" && !canRender) ? "source" : requested;

  return {
    active,
    sourceEditable,
    options: [
      {
        id: "rendered",
        label: "Rendered",
        title: canRender ? "Show rendered Markdown" : "Rendered Markdown is not available yet",
        disabled: !canRender,
      },
      {
        id: "source",
        label: "Source",
        title: sourceEditable ? "Edit Markdown source" : "Inspect Markdown source",
        disabled: false,
      },
      {
        id: "split",
        label: "Split",
        title: "Side-by-side source and rendered Markdown is planned",
        disabled: true,
      },
    ],
  };
}

export function projectMarkdownDocumentOutline(
  plan: MarkdownProjectionPlan,
): MarkdownDocumentOutlineItem[] {
  return plan.anchors.map((anchor, index) => markdownAnchorToOutlineItem(anchor, index));
}

export function markdownDocumentHeadingAnchors(
  outlineItems: readonly MarkdownDocumentOutlineItem[],
): MarkdownDocumentHeadingAnchor[] {
  return outlineItems.map((item) => ({
    itemId: item.id,
    title: item.title,
    level: item.level,
    anchor: item.anchor,
    headingAnchorId: item.anchor,
  }));
}

export function normalizeMarkdownDocumentAccess(
  access: MarkdownDocumentAccessLevel | null | undefined,
): MarkdownDocumentAccessLevel {
  return access === "owner" || access === "editor" || access === "viewer" ? access : "none";
}

export function normalizeMarkdownDocumentTitle(
  title: string | null | undefined,
  fallbackId: string,
): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `Markdown ${fallbackId.slice(0, 8)}`;
}

function markdownAnchorToOutlineItem(
  anchor: MarkdownProjectionAnchor,
  index: number,
): MarkdownDocumentOutlineItem {
  const cleanAnchor = cleanMarkdownAnchor(anchor.slug) || `heading-${index + 1}`;
  return {
    id: anchor.anchorId || `${anchor.blockId}:heading:${index}`,
    title: anchor.title,
    level: anchor.level,
    anchor: cleanAnchor,
    href: `#${cleanAnchor}`,
    sourceSpanUtf16: anchor.sourceSpanUtf16,
    blockId: anchor.blockId,
  };
}

function cleanMarkdownAnchor(anchor: string): string {
  return anchor.replace(/^#+/, "").trim();
}
