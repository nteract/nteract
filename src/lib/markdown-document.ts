import {
  canRenderMarkdownProjectionInHost,
  projectMarkdownPlan,
  type MarkdownProjectionAnchor,
  type MarkdownProjectionPlan,
} from "./markdown-projection";

export type MarkdownDocumentAccessLevel = "owner" | "editor" | "viewer" | "none";
export type MarkdownDocumentMode = "read" | "source";

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
  access?: MarkdownDocumentAccessLevel | null;
  requestedMode?: MarkdownDocumentMode | null;
  publishedRevisionId?: string | null;
  updatedAt?: string | null;
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
  outlineItems: readonly MarkdownDocumentOutlineItem[];
  headingAnchors: readonly MarkdownDocumentHeadingAnchor[];
}

export function projectMarkdownDocument(
  input: MarkdownDocumentProjectionInput,
): MarkdownDocumentProjection {
  const access = normalizeMarkdownDocumentAccess(input.access);
  const body = input.body ?? "";
  const canEdit = access === "owner" || access === "editor";
  const mode = canEdit ? (input.requestedMode ?? "read") : "read";
  const markdownPlan = projectMarkdownPlan(body);
  const publishedRevisionId = input.publishedRevisionId ?? null;

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
    canRenderInHost: canRenderMarkdownProjectionInHost(markdownPlan),
    outlineItems,
    headingAnchors: markdownDocumentHeadingAnchors(outlineItems),
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
