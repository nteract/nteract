mod doc;
pub mod error;
mod handle;
mod identity;
mod types;

pub use doc::{CommentsDoc, CommentsDocReceiveRepairResult};
pub use error::CommentsDocError;
pub use handle::CommentsDocHandle;
pub use identity::{
    local_path_comments_doc_id, local_path_comments_identity, local_room_comments_doc_id,
    local_room_comments_identity, LocalCommentsIdentity,
};
pub use types::{
    validate_comment_anchor, validate_source_range_anchor_against_source, CommentAnchor,
    CommentCreated, CommentMessageSnapshot, CommentReplied, CommentThreadSnapshot,
    CommentsProjection, NotebookCommentRef, ProjectedThreadStatus,
};
