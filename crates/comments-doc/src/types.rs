use serde::{Deserialize, Serialize};

pub const MAX_SOURCE_COMMENT_QUOTE_BYTES: usize = 4096;

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

pub fn validate_comment_anchor(anchor: &CommentAnchor) -> Result<(), String> {
    let CommentAnchor::SourceRange {
        start_line,
        start_column,
        end_line,
        end_column,
        prefix_quote,
        exact_quote,
        suffix_quote,
        ..
    } = anchor
    else {
        return Ok(());
    };

    validate_source_range_order(*start_line, *start_column, *end_line, *end_column)?;
    validate_source_quote_bound("prefix_quote", prefix_quote.as_deref())?;
    validate_source_quote_bound("exact_quote", exact_quote.as_deref())?;
    validate_source_quote_bound("suffix_quote", suffix_quote.as_deref())?;
    Ok(())
}

pub fn validate_source_range_anchor_against_source(
    anchor: &CommentAnchor,
    source: &str,
) -> Result<(), String> {
    validate_comment_anchor(anchor)?;

    let CommentAnchor::SourceRange {
        start_line,
        start_column,
        end_line,
        end_column,
        exact_quote,
        ..
    } = anchor
    else {
        return Ok(());
    };

    // Fast path: the stored line/column still resolves and, when an exact quote
    // is present, the text there still matches it.
    if let (Ok(start), Ok(end)) = (
        source_byte_offset_from_utf16_point(source, *start_line, *start_column),
        source_byte_offset_from_utf16_point(source, *end_line, *end_column),
    ) {
        if start <= end {
            match exact_quote {
                None => return Ok(()),
                Some(quote) if &source[start..end] == quote => return Ok(()),
                Some(_) => {}
            }
        }
    }

    // Repair path: the document shifted since the comment was authored, so the
    // stored line/column no longer lines up. Accept as long as the quoted text
    // still exists somewhere in the source — clients resolve the live position
    // by quote on render. Only reject when the quoted text is truly gone (or
    // there is no quote to re-anchor by), which is the one case where the
    // comment has genuinely lost its target.
    match exact_quote {
        Some(quote) if !quote.is_empty() && source.contains(quote.as_str()) => Ok(()),
        Some(_) => {
            Err("source_range exact_quote no longer present in current cell source".to_string())
        }
        None => Err(format!(
            "source_range position ({start_line}:{start_column}) is outside current cell source"
        )),
    }
}

fn validate_source_range_order(
    start_line: u64,
    start_column: u64,
    end_line: u64,
    end_column: u64,
) -> Result<(), String> {
    if start_line > end_line || (start_line == end_line && start_column > end_column) {
        return Err(format!(
            "source_range start ({start_line}:{start_column}) must be before or equal to end ({end_line}:{end_column})"
        ));
    }
    Ok(())
}

fn validate_source_quote_bound(field: &str, quote: Option<&str>) -> Result<(), String> {
    let Some(quote) = quote else {
        return Ok(());
    };
    if quote.len() > MAX_SOURCE_COMMENT_QUOTE_BYTES {
        return Err(format!(
            "source_range {field} exceeds {MAX_SOURCE_COMMENT_QUOTE_BYTES} bytes"
        ));
    }
    Ok(())
}

fn source_byte_offset_from_utf16_point(
    source: &str,
    line: u64,
    column: u64,
) -> Result<usize, String> {
    let mut line_start = 0;
    for _ in 0..line {
        let Some(relative_newline) = source[line_start..].find('\n') else {
            return Err(format!(
                "source_range line {line} is outside current cell source"
            ));
        };
        line_start += relative_newline + 1;
    }

    let line_end = source[line_start..]
        .find('\n')
        .map(|relative_newline| line_start + relative_newline)
        .unwrap_or(source.len());
    let line_text = &source[line_start..line_end];
    let mut utf16_offset = 0_u64;
    for (byte_offset, ch) in line_text.char_indices() {
        if utf16_offset == column {
            return Ok(line_start + byte_offset);
        }
        utf16_offset += ch.len_utf16() as u64;
        if utf16_offset > column {
            return Err(format!(
                "source_range column {column} is outside a UTF-16 character boundary"
            ));
        }
    }
    if utf16_offset == column {
        return Ok(line_end);
    }

    Err(format!(
        "source_range column {column} is outside current cell source line"
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_source_range_exact_quote_against_current_source() {
        let anchor = CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 4,
            prefix_quote: None,
            exact_quote: Some("beta".into()),
            suffix_quote: None,
        };

        assert!(validate_source_range_anchor_against_source(&anchor, "alpha\nbeta\n").is_ok());
        assert!(validate_source_range_anchor_against_source(&anchor, "alpha\ngamma\n").is_err());
    }

    #[test]
    fn repairs_source_range_anchor_when_document_shifted() {
        // Anchor authored at line 1, but the cell gained a line above so the
        // quoted text now lives on line 2. The stored line/column no longer
        // matches, yet the quote is still present: finalize should accept.
        let anchor = CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 4,
            prefix_quote: None,
            exact_quote: Some("beta".into()),
            suffix_quote: None,
        };

        assert!(
            validate_source_range_anchor_against_source(&anchor, "added\nalpha\nbeta\n").is_ok(),
            "drifted anchor whose quote still exists should validate"
        );
        // Column out of bounds for the current line, but the quote still exists.
        let out_of_bounds = CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 0,
            start_column: 40,
            end_line: 0,
            end_column: 44,
            prefix_quote: None,
            exact_quote: Some("beta".into()),
            suffix_quote: None,
        };
        assert!(validate_source_range_anchor_against_source(&out_of_bounds, "x\nbeta\n").is_ok());
        // Quote genuinely gone: still rejected.
        assert!(validate_source_range_anchor_against_source(&anchor, "added\nalpha\n").is_err());
    }

    #[test]
    fn validates_source_range_columns_as_utf16_offsets() {
        let anchor = CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 0,
            start_column: 2,
            end_line: 0,
            end_column: 3,
            prefix_quote: None,
            exact_quote: Some("x".into()),
            suffix_quote: None,
        };

        assert!(validate_source_range_anchor_against_source(&anchor, "🙂x\n").is_ok());
    }

    #[test]
    fn rejects_source_quotes_over_storage_bound() {
        let anchor = CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line: 0,
            start_column: 0,
            end_line: 0,
            end_column: 0,
            prefix_quote: None,
            exact_quote: Some("x".repeat(MAX_SOURCE_COMMENT_QUOTE_BYTES + 1)),
            suffix_quote: None,
        };

        assert!(validate_comment_anchor(&anchor).is_err());
    }
}
