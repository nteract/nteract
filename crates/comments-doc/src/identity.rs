use sha2::Digest as _;

use crate::types::NotebookCommentRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCommentsIdentity {
    pub comments_doc_id: String,
    pub notebook_ref: NotebookCommentRef,
}

pub fn local_path_comments_doc_id(canonical_path: impl AsRef<str>) -> String {
    let digest = sha2::Sha256::digest(canonical_path.as_ref().as_bytes());
    format!("comments:local-path:{}", hex::encode(digest))
}

pub fn local_room_comments_doc_id(room_id: impl AsRef<str>) -> String {
    format!("comments:local-room:{}", room_id.as_ref())
}

pub fn local_path_comments_identity(canonical_path: impl Into<String>) -> LocalCommentsIdentity {
    let canonical_path = canonical_path.into();
    LocalCommentsIdentity {
        comments_doc_id: local_path_comments_doc_id(&canonical_path),
        notebook_ref: NotebookCommentRef::LocalPath { canonical_path },
    }
}

pub fn local_room_comments_identity(room_id: impl Into<String>) -> LocalCommentsIdentity {
    let room_id = room_id.into();
    LocalCommentsIdentity {
        comments_doc_id: local_room_comments_doc_id(&room_id),
        notebook_ref: NotebookCommentRef::LocalRoom { room_id },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_path_identity_hashes_canonical_path() {
        let identity = local_path_comments_identity("/tmp/notebook.ipynb");

        assert_eq!(
            identity.comments_doc_id,
            "comments:local-path:63bbd3f2251d51b5bde4331cdcd8a860e338635079eb34f9572bd7d039113550"
        );
        assert_eq!(
            identity.notebook_ref,
            NotebookCommentRef::LocalPath {
                canonical_path: "/tmp/notebook.ipynb".to_string()
            }
        );
    }

    #[test]
    fn local_room_identity_uses_stable_room_id() {
        let identity = local_room_comments_identity("room-1");

        assert_eq!(identity.comments_doc_id, "comments:local-room:room-1");
        assert_eq!(
            identity.notebook_ref,
            NotebookCommentRef::LocalRoom {
                room_id: "room-1".to_string()
            }
        );
    }
}
