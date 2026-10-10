//! Notebook IDs name a notebook within an explicit authority, never an active slot.
//!
//! This first resolver only retains already connected replicas. Network admission
//! stays in connect_notebook: resolving a read must not start a peer or kernel.

use crate::cloud::{HostedCredentials, NotebookTarget};
use crate::session::{NotebookSession, NotebookSessionSource};
use crate::session_activation::CanonicalNotebookTarget;
use crate::NteractMcp;
use rmcp::ErrorData;

fn target_error(code: &str, message: &str, notebook_id: &str, domain: Option<&str>) -> ErrorData {
    ErrorData::invalid_params(
        message.to_owned(),
        Some(serde_json::json!({
            "code":code, "notebook_id":notebook_id, "domain":domain,
            "connect_with":{"notebook_id":notebook_id,"domain":domain},
            "resubmit_required":true,
        })),
    )
}

pub(crate) async fn acquire(
    server: &NteractMcp,
    notebook_id: &str,
    domain: Option<&str>,
) -> Result<NotebookSession, ErrorData> {
    let target = crate::cloud::parse_connect_target(None, None, Some(notebook_id), domain)
        .map_err(|message| {
            target_error("invalid_notebook_target", &message, notebook_id, domain)
        })?;
    let acquired = match target {
        NotebookTarget::LocalNotebookId(id) => {
            let id = uuid::Uuid::parse_str(&id)
                .map_err(|error| {
                    target_error(
                        "invalid_notebook_target",
                        &error.to_string(),
                        notebook_id,
                        domain,
                    )
                })?
                .to_string();
            let incarnation =
                crate::session::query_current_daemon_incarnation(server.socket_path.clone())
                    .await
                    .ok_or_else(|| {
                        target_error(
                            "daemon_unavailable",
                            "The configured local daemon is unavailable",
                            &id,
                            None,
                        )
                    })?;
            let operator = server.get_operator().await;
            server.attachments.acquire_address(
                &CanonicalNotebookTarget::new(format!("local:id:{id}")),
                |session| {
                    session.notebook_id == id
                        && session.source == NotebookSessionSource::Local
                        && session.local_daemon_incarnation.as_ref() == Some(&incarnation)
                        && session.handle.get_actor_id().is_ok_and(|actor| {
                            crate::replica::belongs_to_operator(&actor, &operator)
                        })
                        && usable_connection(session)
                },
            )
        }
        NotebookTarget::Hosted {
            domain,
            notebook_id: id,
            ..
        } => {
            let credentials = current_hosted_credentials(&domain).map_err(|message| {
                target_error(
                    "notebook_authority_unavailable",
                    &message,
                    &id,
                    Some(&domain),
                )
            })?;
            acquire_hosted(server, &domain, &id, &credentials)
        }
        NotebookTarget::LocalPath(_) => unreachable!("ID parser cannot return a path"),
    };
    acquired.map_err(|code| target_error(code, match code {
        "attachment_limit" => "Notebook retention is at capacity; release an unneeded exact notebook_handle before retrying; resources/list lists retained handles",
        "ambiguous_notebook_authority" => "Connected replicas disagree on authenticated authority; use an exact notebook_handle",
        _ => "No connected replica matches this notebook and current authority. Call connect_notebook with this exact notebook_id/domain, then retry; no notebook was opened or created",
    }, notebook_id, domain))
}

fn acquire_hosted(
    server: &NteractMcp,
    domain: &str,
    notebook_id: &str,
    credentials: &HostedCredentials,
) -> Result<NotebookSession, &'static str> {
    server.attachments.acquire_address(
        &CanonicalNotebookTarget::new(crate::cloud::hosted_notebook_url(domain, notebook_id)),
        |session| {
            session.notebook_id == notebook_id
                && session.source
                    == NotebookSessionSource::Hosted {
                        domain: domain.to_owned(),
                    }
                && session.hosted_authority.as_ref().is_some_and(|authority| {
                    authority.credentials.matches(credentials)
                        && authority.requested_scope == "editor"
                })
                && usable_connection(session)
        },
    )
}

fn usable_connection(session: &NotebookSession) -> bool {
    let status = session.handle.status();
    status.connection == notebook_sync::ConnectionState::Connected
        && !matches!(
            status.initial_load,
            notebook_sync::InitialLoadPhase::Failed { .. }
        )
}

fn current_hosted_credentials(domain: &str) -> Result<HostedCredentials, String> {
    let registry = crate::cloud::CloudRegistry::load_default()?
        .ok_or_else(|| "No cloud domain registry is configured".to_owned())?;
    let config = registry
        .domain(domain)?
        .ok_or_else(|| format!("Cloud domain {domain} is not configured"))?;
    HostedCredentials::resolve(&config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::AttachmentOrigin;
    use crate::cloud::{HostedAuthority, ResolvedCloudDomain};
    use notebook_cloud_transport::CloudAuth;
    use notebook_protocol::connection::{FrameSource, TypedNotebookFrame, WriterFrameSink};

    const DOMAIN: &str = "https://first.invalid";
    const OTHER_DOMAIN: &str = "https://second.invalid";
    const NOTEBOOK: &str = "01KTZA152886TK1WAHYA48G7HJ";
    const OPERATOR: &str = "agent:routing-test";

    struct IdleFrames;

    impl FrameSource for IdleFrames {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            std::future::pending().await
        }
    }

    struct ClosingFrames(tokio::sync::oneshot::Receiver<()>);

    impl FrameSource for ClosingFrames {
        async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
            let _ = (&mut self.0).await;
            None
        }
    }

    fn server() -> NteractMcp {
        // The hosted resolver must not consult or open this local endpoint.
        NteractMcp::new("/unused-hosted-resolver-test.sock".into(), None, None)
    }

    fn credentials(domain: &str, operator: &str, auth: CloudAuth) -> HostedCredentials {
        HostedCredentials::resolve(&ResolvedCloudDomain::with_auth_override(
            domain,
            Some(operator.to_owned()),
            auth,
        ))
        .unwrap()
    }

    fn api_key(token: &str) -> CloudAuth {
        CloudAuth::AnacondaApiKey {
            token: token.into(),
        }
    }

    async fn session(
        domain: &str,
        notebook_id: &str,
        principal: &str,
        credentials: HostedCredentials,
    ) -> NotebookSession {
        let handle = notebook_sync::connect::connect_frame_io(
            notebook_id.into(),
            &format!("{principal}/{OPERATOR}:{}", uuid::Uuid::new_v4()),
            IdleFrames,
            WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        let mut session = NotebookSession::hosted(handle, notebook_id.into(), domain.into());
        session.hosted_authority = Some(HostedAuthority {
            credentials,
            principal: principal.into(),
            requested_scope: "editor",
        });
        session
    }

    fn retain(server: &NteractMcp, session: NotebookSession) {
        server
            .attachments
            .insert(session, server.attachments.reserve().unwrap());
    }

    fn assert_not_connected(result: Result<NotebookSession, &'static str>) {
        assert_eq!(result.err(), Some("notebook_not_connected"));
    }

    #[tokio::test]
    async fn hosted_id_retains_one_owner_independent_of_explicit_handles() {
        let server = server();
        let current = credentials(DOMAIN, OPERATOR, api_key("synthetic-token"));
        let connected = session(DOMAIN, NOTEBOOK, "anaconda:alice", current.clone()).await;
        let explicit = connected.notebook_handle.clone();
        retain(&server, connected);

        let address = acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
        assert_ne!(address.notebook_handle, explicit);
        assert_eq!(
            server.attachments.read_entries()[&address.notebook_handle].origin(),
            AttachmentOrigin::Address
        );
        drop(server.attachments.remove(&explicit));

        let again = acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
        assert_eq!(again.notebook_handle, address.notebook_handle);
        assert_eq!(server.attachments.read_entries().len(), 1);
        drop(server.attachments.remove(&address.notebook_handle));
        assert_not_connected(acquire_hosted(&server, DOMAIN, NOTEBOOK, &current));
    }

    #[tokio::test]
    async fn terminal_address_connection_releases_capacity_without_expiring_other_owners() {
        let server = server();
        let current = credentials(DOMAIN, OPERATOR, api_key("synthetic-token"));
        let (close, closed) = tokio::sync::oneshot::channel();
        let handle = notebook_sync::connect::connect_frame_io(
            NOTEBOOK.into(),
            &format!("anaconda:alice/{OPERATOR}:{}", uuid::Uuid::new_v4()),
            ClosingFrames(closed),
            WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        let mut connected = NotebookSession::hosted(handle, NOTEBOOK.into(), DOMAIN.into());
        connected.hosted_authority = Some(HostedAuthority {
            credentials: current.clone(),
            principal: "anaconda:alice".into(),
            requested_scope: "editor",
        });
        let explicit = connected.notebook_handle.clone();
        let legacy = connected.fresh_attachment(
            0,
            &CanonicalNotebookTarget::new(crate::cloud::hosted_notebook_url(DOMAIN, NOTEBOOK)),
        );
        let legacy_handle = legacy.notebook_handle.clone();
        retain(&server, connected);
        server
            .attachments
            .insert_legacy(legacy, server.attachments.reserve().unwrap());
        let address = acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
        let expiration = server.attachments.read_entries()[&address.notebook_handle].expiration();
        retain(
            &server,
            session(DOMAIN, "live-notebook", "anaconda:alice", current.clone()).await,
        );
        let live = acquire_hosted(&server, DOMAIN, "live-notebook", &current).unwrap();
        let _reservations: Vec<_> =
            std::iter::from_fn(|| server.attachments.reserve().ok()).collect();
        assert!(server.attachments.reserve().is_err());
        server.attachments.reap_disconnected_addresses();
        assert!(
            server.attachments.reserve().is_err(),
            "live retention must not be evicted"
        );
        assert!(!*expiration.borrow());

        close.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while address.handle.status().connection != notebook_sync::ConnectionState::Disconnected
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // A valid tool admission runs this cleanup before reserving any new owner.
        let request = rmcp::model::CallToolRequestParams::new("list_active_notebooks");
        let _ = crate::targets::dispatch(&server, &request).await;
        let entries = server.attachments.read_entries();
        assert!(!entries.contains_key(&address.notebook_handle));
        assert!(
            entries.contains_key(&explicit),
            "exact handles keep their observation-loss contract"
        );
        assert!(entries.contains_key(&legacy_handle));
        assert!(entries.contains_key(&live.notebook_handle));
        assert!(*expiration.borrow());
        assert!(
            server.attachments.reserve().is_ok(),
            "dead server retention must release its capacity"
        );
    }

    #[tokio::test]
    async fn rotated_tokens_and_auth_kinds_cannot_reuse_a_retained_hosted_owner() {
        let auths = [
            CloudAuth::OidcBearer {
                token: "synthetic-token".into(),
            },
            api_key("synthetic-token"),
            CloudAuth::WorkstationCredential {
                token: "synthetic-token".into(),
            },
            CloudAuth::Dev {
                token: "synthetic-token".into(),
                user: "alice".into(),
            },
        ];
        for (kind, auth) in auths.iter().enumerate() {
            let server = server();
            let current = credentials(DOMAIN, OPERATOR, auth.clone());
            retain(
                &server,
                session(DOMAIN, NOTEBOOK, "anaconda:alice", current.clone()).await,
            );
            let address = acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
            let count = server.attachments.read_entries().len();

            let rotated = credentials(DOMAIN, OPERATOR, auth.with_token("rotated-token".into()));
            assert_not_connected(acquire_hosted(&server, DOMAIN, NOTEBOOK, &rotated));
            for (other_kind, other_auth) in auths.iter().enumerate() {
                if kind != other_kind {
                    let changed = credentials(DOMAIN, OPERATOR, other_auth.clone());
                    assert_not_connected(acquire_hosted(&server, DOMAIN, NOTEBOOK, &changed));
                }
            }
            server.attachments.reap_disconnected_addresses();
            let resources = crate::resources::list_resources_for_mode(&server, true)
                .await
                .unwrap();
            assert!(
                resources.resources.iter().any(|resource| {
                    resource.uri == crate::resources::attachment_cells_uri(&address.notebook_handle)
                }),
                "live owners remain discoverable after credentials change"
            );
            assert_eq!(server.attachments.read_entries().len(), count);
            assert_eq!(
                acquire_hosted(&server, DOMAIN, NOTEBOOK, &current)
                    .unwrap()
                    .notebook_handle,
                address.notebook_handle
            );
        }
    }

    #[tokio::test]
    async fn changed_dev_user_operator_or_domain_cannot_borrow_an_existing_authority() {
        let server = server();
        let auth = CloudAuth::Dev {
            token: "synthetic-dev-token".into(),
            user: "alice".into(),
        };
        let current = credentials(DOMAIN, OPERATOR, auth.clone());
        retain(
            &server,
            session(DOMAIN, NOTEBOOK, "local:alice", current.clone()).await,
        );
        acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
        let changed = [
            credentials(
                DOMAIN,
                OPERATOR,
                CloudAuth::Dev {
                    token: "synthetic-dev-token".into(),
                    user: "bob".into(),
                },
            ),
            credentials(DOMAIN, "agent:other", auth.clone()),
            credentials(OTHER_DOMAIN, OPERATOR, auth),
        ];
        for credentials in changed {
            assert_not_connected(acquire_hosted(
                &server,
                &credentials.domain,
                NOTEBOOK,
                &credentials,
            ));
        }
        assert_eq!(server.attachments.read_entries().len(), 2);
    }

    #[tokio::test]
    async fn missing_authority_or_viewer_request_cannot_authorize_id_routing() {
        let server = server();
        let current = credentials(DOMAIN, OPERATOR, api_key("synthetic-token"));
        assert_not_connected(acquire_hosted(&server, DOMAIN, NOTEBOOK, &current));
        let mut unbound = session(DOMAIN, NOTEBOOK, "anaconda:alice", current.clone()).await;
        unbound.hosted_authority = None;
        retain(&server, unbound);
        let mut viewer = session(DOMAIN, NOTEBOOK, "anaconda:alice", current.clone()).await;
        viewer.hosted_authority.as_mut().unwrap().requested_scope = "viewer";
        retain(&server, viewer);

        assert_not_connected(acquire_hosted(&server, DOMAIN, NOTEBOOK, &current));
        assert_eq!(server.attachments.read_entries().len(), 2);
        assert!(server
            .attachments
            .read_entries()
            .values()
            .all(|entry| entry.origin() == AttachmentOrigin::Explicit));
    }

    #[tokio::test]
    async fn conflicting_authenticated_principals_reject_even_a_cached_address_owner() {
        let server = server();
        let current = credentials(DOMAIN, OPERATOR, api_key("synthetic-token"));
        retain(
            &server,
            session(DOMAIN, NOTEBOOK, "anaconda:alice", current.clone()).await,
        );
        let address = acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).unwrap();
        let other = session(DOMAIN, NOTEBOOK, "anaconda:bob", current.clone()).await;
        let other_handle = other.notebook_handle.clone();
        retain(&server, other);

        assert_eq!(
            acquire_hosted(&server, DOMAIN, NOTEBOOK, &current).err(),
            Some("ambiguous_notebook_authority")
        );
        assert_eq!(server.attachments.read_entries().len(), 3);
        drop(server.attachments.remove(&other_handle));
        assert_eq!(
            acquire_hosted(&server, DOMAIN, NOTEBOOK, &current)
                .unwrap()
                .notebook_handle,
            address.notebook_handle
        );
    }

    #[tokio::test]
    async fn identical_notebook_ids_in_different_domains_route_to_distinct_documents() {
        let server = server();
        let first_credentials = credentials(DOMAIN, OPERATOR, api_key("synthetic-token"));
        let second_credentials = credentials(OTHER_DOMAIN, OPERATOR, api_key("synthetic-token"));
        let first = session(
            DOMAIN,
            NOTEBOOK,
            "anaconda:alice",
            first_credentials.clone(),
        )
        .await;
        let second = session(
            OTHER_DOMAIN,
            NOTEBOOK,
            "anaconda:alice",
            second_credentials.clone(),
        )
        .await;
        first
            .handle
            .add_cell_with_source("sentinel", "markdown", None, "first domain")
            .unwrap();
        second
            .handle
            .add_cell_with_source("sentinel", "markdown", None, "second domain")
            .unwrap();
        retain(&server, first.clone());
        retain(&server, second.clone());

        let first_address = acquire_hosted(&server, DOMAIN, NOTEBOOK, &first_credentials).unwrap();
        let second_address =
            acquire_hosted(&server, OTHER_DOMAIN, NOTEBOOK, &second_credentials).unwrap();
        assert_ne!(
            first_address.notebook_handle,
            second_address.notebook_handle
        );
        assert_eq!(
            first_address.handle.get_cell_source("sentinel").as_deref(),
            Some("first domain")
        );
        assert_eq!(
            second_address.handle.get_cell_source("sentinel").as_deref(),
            Some("second domain")
        );
        first_address
            .handle
            .add_cell_with_source("new-cell", "markdown", None, "first only")
            .unwrap();
        assert_eq!(
            first.handle.get_cell_source("new-cell").as_deref(),
            Some("first only")
        );
        assert_eq!(second.handle.get_cell_source("new-cell"), None);
        assert_not_connected(acquire_hosted(
            &server,
            DOMAIN,
            "01KTZA152886TK1WAHYA48G7HK",
            &first_credentials,
        ));
        assert_eq!(server.attachments.read_entries().len(), 4);
    }
}
