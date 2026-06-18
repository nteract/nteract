use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotebookCommentRef {
    HostedRoom { room_locator: String },
    LocalPath { canonical_path: String },
    LocalRoom { room_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommentAnchor {
    Notebook,
    Cell {
        cell_id: String,
        #[serde(default)]
        observed_cell_position: Option<String>,
    },
    CellRange {
        start_cell_id: String,
        end_cell_id: String,
        #[serde(default)]
        start_position: Option<String>,
        #[serde(default)]
        end_position: Option<String>,
    },
    SourceRange {
        cell_id: String,
        start_line: u64,
        start_column: u64,
        end_line: u64,
        end_column: u64,
        #[serde(default)]
        prefix_quote: Option<String>,
        #[serde(default)]
        exact_quote: Option<String>,
        #[serde(default)]
        suffix_quote: Option<String>,
    },
    Output {
        cell_id: String,
        #[serde(default)]
        execution_id: Option<String>,
        #[serde(default)]
        output_id: Option<String>,
    },
}

impl CommentAnchor {
    pub fn thread_order_scope(&self) -> String {
        match self {
            Self::Notebook => "notebook".to_string(),
            Self::Cell { cell_id, .. } | Self::SourceRange { cell_id, .. } => {
                format!("cell:{cell_id}")
            }
            Self::Output {
                cell_id,
                execution_id,
                output_id,
            } => format!(
                "output:{}:{}:{}",
                cell_id,
                execution_id.as_deref().unwrap_or_default(),
                output_id.as_deref().unwrap_or_default()
            ),
            Self::CellRange {
                start_cell_id,
                end_cell_id,
                ..
            } => format!("cell_range:{start_cell_id}:{end_cell_id}"),
        }
    }

    pub fn badge_cell_ids(&self, current_cell_order: Option<&[String]>) -> Vec<String> {
        match self {
            Self::Notebook => Vec::new(),
            Self::Cell { cell_id, .. }
            | Self::SourceRange { cell_id, .. }
            | Self::Output { cell_id, .. } => vec![cell_id.clone()],
            Self::CellRange {
                start_cell_id,
                end_cell_id,
                ..
            } => {
                let Some(order) = current_cell_order else {
                    return sorted_unique([start_cell_id.clone(), end_cell_id.clone()]);
                };
                let start = order.iter().position(|id| id == start_cell_id);
                let end = order.iter().position(|id| id == end_cell_id);
                match (start, end) {
                    (Some(a), Some(b)) => {
                        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
                        order[lo..=hi].to_vec()
                    }
                    _ => sorted_unique([start_cell_id.clone(), end_cell_id.clone()]),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentMessageSnapshot {
    pub id: String,
    pub position: String,
    pub body: String,
    pub mutation_state: ProjectedMutationState,
    pub trusted: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub created_by_actor_label: Option<String>,
    #[serde(default)]
    pub created_by_authority: Option<String>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentThreadSnapshot {
    pub id: String,
    pub anchor: CommentAnchor,
    pub position: String,
    pub status: ProjectedThreadStatus,
    pub mutation_state: ProjectedMutationState,
    pub trusted: bool,
    pub messages: Vec<CommentMessageSnapshot>,
    pub badge_cell_ids: Vec<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub created_by_actor_label: Option<String>,
    #[serde(default)]
    pub created_by_authority: Option<String>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub resolved_by_actor_label: Option<String>,
    #[serde(default)]
    pub resolved_by_authority: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentsProjection {
    pub comments_doc_id: String,
    pub threads: Vec<CommentThreadSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedMutationState {
    Pending,
    Accepted,
    Rejected,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedThreadStatus {
    Open,
    Resolved,
    Unverified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentCreated {
    pub thread_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentReplied {
    pub thread_id: String,
    pub message_id: String,
}

fn sorted_unique<const N: usize>(values: [String; N]) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values.dedup();
    values
}
