mod doc;
pub mod error;
mod handle;
mod identity;
mod types;

pub use doc::{CommentsDoc, COMMENTS_DOC_DEFAULT_ACTOR};
pub use error::CommentsDocError;
pub use handle::CommentsDocHandle;
pub use identity::{
    local_path_comments_doc_id, local_path_comments_identity, local_room_comments_doc_id,
    local_room_comments_identity, LocalCommentsIdentity,
};
pub use types::{
    CommentAnchor, CommentCreated, CommentMessageSnapshot, CommentReplied, CommentThreadSnapshot,
    CommentsProjection, NotebookCommentRef, ProjectedMutationState, ProjectedThreadStatus,
};
