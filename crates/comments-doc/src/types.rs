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
    #[serde(default)]
    pub created_at: String,
    /// Author principal, read from the Automerge change that created the
    /// message object. Trust comes from the sync ingress binding a connection
    /// to its actor id before admitting its changes, not from a stored field.
    #[serde(default)]
    pub created_by_actor_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentThreadSnapshot {
    pub id: String,
    pub anchor: CommentAnchor,
    pub position: String,
    pub status: ProjectedThreadStatus,
    pub messages: Vec<CommentMessageSnapshot>,
    pub badge_cell_ids: Vec<String>,
    #[serde(default)]
    pub created_at: String,
    /// Author principal, read from the change that created the thread object.
    #[serde(default)]
    pub created_by_actor_label: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    /// Principal that last wrote the resolved status, read from that field's
    /// change author.
    #[serde(default)]
    pub resolved_by_actor_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentsProjection {
    pub comments_doc_id: String,
    pub threads: Vec<CommentThreadSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedThreadStatus {
    Open,
    Resolved,
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

    fn source_anchor(
        start_line: u64,
        start_column: u64,
        end_line: u64,
        end_column: u64,
        exact_quote: Option<&str>,
    ) -> CommentAnchor {
        CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line,
            start_column,
            end_line,
            end_column,
            prefix_quote: None,
            exact_quote: exact_quote.map(str::to_string),
            suffix_quote: None,
        }
    }

    #[test]
    fn validates_source_range_anchor_against_current_source() {
        let anchor = source_anchor(1, 0, 1, 4, Some("beta"));

        assert!(validate_source_range_anchor_against_source(&anchor, "alpha\nbeta\n").is_ok());
        assert!(validate_source_range_anchor_against_source(&anchor, "alpha\ngamma\n").is_err());
    }

    #[test]
    fn repairs_source_range_anchor_when_document_shifted() {
        let anchor = source_anchor(1, 0, 1, 4, Some("beta"));

        assert!(
            validate_source_range_anchor_against_source(&anchor, "added\nalpha\nbeta\n").is_ok()
        );

        let out_of_bounds = source_anchor(0, 40, 0, 44, Some("beta"));
        assert!(validate_source_range_anchor_against_source(&out_of_bounds, "x\nbeta\n").is_ok());
        assert!(validate_source_range_anchor_against_source(&anchor, "added\nalpha\n").is_err());
    }

    #[test]
    fn validates_source_range_columns_as_utf16_offsets() {
        let anchor = source_anchor(0, 2, 0, 3, Some("x"));

        assert!(validate_source_range_anchor_against_source(&anchor, "🙂x\n").is_ok());
    }

    #[test]
    fn rejects_source_quotes_over_storage_bound() {
        let anchor = source_anchor(
            0,
            0,
            0,
            0,
            Some(&"x".repeat(MAX_SOURCE_COMMENT_QUOTE_BYTES + 1)),
        );

        assert!(validate_comment_anchor(&anchor).is_err());
    }
}
