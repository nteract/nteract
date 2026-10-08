//! Private-child bridge fixture with real wire requests and terminal metadata.
use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData, ServerHandler};
use serde_json::json;
use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Default)]
pub struct Child {
    handles: Mutex<HashSet<String>>,
    watches: Mutex<HashSet<String>>,
}
impl ServerHandler for Child {
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(
            ["connect_notebook", "disconnect_notebook", "fixture_edit"]
                .into_iter()
                .map(|name| {
                    Tool::new(
                        name,
                        "Attachment bridge fixture",
                        serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(
                            json!({"type":"object"}),
                        )
                        .unwrap(),
                    )
                })
                .collect(),
        ))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.unwrap_or_default();
        if request.name == "connect_notebook" {
            let handle = uuid::Uuid::new_v4().to_string();
            self.handles.lock().unwrap().insert(handle.clone());
            let payload = json!({
                "notebook_handle":handle, "notebook_id":args.get("target"),
                "attachmentMode":context.meta.get("io.nteract/attachmentMode"),
                "protocolVersion": context.peer.peer_info().unwrap().protocol_version,
            });
            let mut result = CallToolResult::success(vec![ContentBlock::text(payload.to_string())]);
            result.structured_content = Some(payload);
            return Ok(result.into());
        }
        let handle = args
            .get("notebook_handle")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if !self.handles.lock().unwrap().contains(handle) {
            return Err(ErrorData::invalid_params(
                "Notebook attachment expired",
                None,
            ));
        }
        let terminal = request.name == "disconnect_notebook";
        if terminal {
            self.handles.lock().unwrap().remove(handle);
        }
        let uris: Vec<_> = self
            .watches
            .lock()
            .unwrap()
            .iter()
            .filter(|uri| uri.starts_with(&format!("nteract://sessions/{handle}/")))
            .cloned()
            .collect();
        for uri in uris {
            let mut update = ResourceUpdatedNotificationParam::new(uri);
            if terminal {
                update.meta = Some(serde_json::from_value(json!({"io.nteract/attachmentExpired":{"code":"attachment_expired","notebook_handle":handle}})).unwrap());
            }
            context.peer.notify_resource_updated(update).await.unwrap();
        }
        Ok(CallToolResult::success(vec![]).into())
    }
    #[allow(deprecated)]
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        self.watches.lock().unwrap().insert(request.uri.clone());
        // Invalidation before acknowledgment exercises the relay's initial cursor.
        context
            .peer
            .notify_resource_updated(ResourceUpdatedNotificationParam::new(request.uri))
            .await
            .unwrap();
        Ok(())
    }
    #[allow(deprecated)]
    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        self.watches.lock().unwrap().remove(&request.uri);
        Ok(())
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let handle = request
            .uri
            .strip_prefix("nteract://sessions/")
            .unwrap_or_default()
            .split('/')
            .next()
            .unwrap_or_default();
        if !self.handles.lock().unwrap().contains(handle) {
            return Err(ErrorData::resource_not_found(
                "Notebook attachment expired",
                Some(json!({"code":"attachment_expired","notebook_handle":handle})),
            ));
        }
        if request.uri.ends_with("/missing") {
            return Err(ErrorData::resource_not_found("Missing cell", None));
        }
        Ok(ReadResourceResult::new(vec![]).into())
    }
}
