/**
 * View-model types for the comments UI.
 *
 * These mirror the shapes the daemon's comments projection produces, but are
 * declared here so the comment UI components stand alone as design-system
 * elements, renderable from fixtures without depending on the runtime/daemon
 * package. The app maps the wire projection onto these at the edge.
 */

export type CommentAnchor =
  | { kind: "notebook" }
  | { kind: "cell"; cell_id: string; observed_cell_position?: string | null }
  | {
      kind: "cell_range";
      start_cell_id: string;
      end_cell_id: string;
      start_position?: string | null;
      end_position?: string | null;
    }
  | {
      kind: "source_range";
      cell_id: string;
      start_line: number;
      start_column: number;
      end_line: number;
      end_column: number;
      prefix_quote?: string | null;
      exact_quote?: string | null;
      suffix_quote?: string | null;
    }
  | {
      kind: "output";
      cell_id: string;
      execution_id?: string | null;
      output_id?: string | null;
    };

export type CommentThreadStatus = "open" | "resolved";

export interface CommentMessageSnapshot {
  id: string;
  position: string;
  body: string;
  created_at: string;
  created_by_actor_label?: string | null;
}

export interface CommentThreadSnapshot {
  id: string;
  anchor: CommentAnchor;
  position: string;
  status: CommentThreadStatus;
  messages: CommentMessageSnapshot[];
  badge_cell_ids: string[];
  created_at: string;
  created_by_actor_label?: string | null;
  resolved_at?: string | null;
  resolved_by_actor_label?: string | null;
}

export interface CommentsProjection {
  comments_doc_id: string;
  threads: CommentThreadSnapshot[];
}
