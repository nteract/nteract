//! Shared ordinary initialize-based wire assertions. No attachmentMode opt-in.
#![allow(dead_code)]

use crate::attachments::{read, result, tool_params};
use crate::support::Wire;
use serde_json::{json, Value};
use std::path::Path;

pub async fn interleaved_chats(
    wire: &mut Wire,
    a: &str,
    b: &str,
    paths: [&Path; 2],
    first_id: u64,
) {
    let mut created = Vec::new();
    for (index, handle) in [a, b].into_iter().enumerate() {
        let response = wire.request(first_id + index as u64, "tools/call", Some(tool_params("create_cell", json!({"notebook_handle":handle,"source":format!("created by chat {index}"),"cell_type":"markdown","after_cell_id":"sentinel"}), false))).await;
        let link = result(&response)["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "resource_link")
            .unwrap();
        let uri = link["uri"].as_str().unwrap();
        assert!(
            uri.starts_with(&format!("nteract://sessions/{handle}/cells/")),
            "create result must name its captured owner"
        );
        created.push(uri.rsplit('/').next().unwrap().to_owned());
    }
    assert_ne!(created[0], created[1]);
    // A and B deliberately reuse sentinel; request interleaving must not pick
    // the other chat's current notebook or its same-named cell.
    for (offset, (handle, source)) in [
        (a, "chat A source"),
        (b, "chat B source"),
        (a, "chat A final"),
    ]
    .into_iter()
    .enumerate()
    {
        result(&wire.request(first_id + 10 + offset as u64, "tools/call", Some(tool_params("set_cell", json!({"notebook_handle":handle,"cell_id":"sentinel","cell_type":"code","source":source}), false))).await);
    }
    for (index, (handle, expected)) in [(a, "chat A final"), (b, "chat B source")]
        .into_iter()
        .enumerate()
    {
        let cells = read(wire, first_id + 20 + index as u64, handle, false).await;
        assert_eq!(cells["cells"][0]["source_preview"], expected);
        assert!(cells["cells"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cell| cell["cell_id"] == created[index]));
        assert!(!cells["cells"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cell| cell["cell_id"] == created[1 - index]));
        let response = wire
            .request(
                first_id + 30 + index as u64,
                "tools/call",
                Some(tool_params(
                    "get_cell",
                    json!({"notebook_handle":handle,"cell_id":"sentinel"}),
                    false,
                )),
            )
            .await;
        assert!(result(&response)["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(expected));
        // Synced code cell, deliberately no runnable kernel. Admission must
        // report the captured notebook's readiness, never select the other.
        let response = wire
            .request(
                first_id + 40 + index as u64,
                "tools/call",
                Some(tool_params(
                    "execute_cell",
                    json!({"notebook_handle":handle,"cell_id":"sentinel","timeout_secs":0.01}),
                    false,
                )),
            )
            .await;
        assert_eq!(response["result"]["isError"], true);
        let details = &response["result"]["structuredContent"];
        assert_eq!(
            details["session"]["target"],
            format!("local:path:{}", paths[index].display())
        );
        assert_eq!(details["session"]["capabilities"]["execute"], false);
    }
}

pub async fn missing_targets(wire: &mut Wire, first_id: u64) -> Vec<Value> {
    let mut responses = Vec::new();
    for (index, (name, args)) in [
        (
            "create_cell",
            json!({"source":"untargeted create","cell_type":"markdown"}),
        ),
        (
            "set_cell",
            json!({"cell_id":"sentinel","source":"untargeted mutation"}),
        ),
        ("get_cell", json!({"cell_id":"sentinel"})),
        (
            "execute_cell",
            json!({"cell_id":"sentinel","timeout_secs":0.01}),
        ),
        ("run_all_cells", json!({"wait":false})),
        ("disconnect_notebook", json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        for (variant, target) in [None, Some(json!("")), Some(Value::Null), Some(json!(42))]
            .into_iter()
            .enumerate()
        {
            let mut arguments = args.clone();
            if let Some(target) = target {
                arguments["notebook_handle"] = target;
            }
            responses.push(
                wire.request(
                    first_id + index as u64 * 4 + variant as u64,
                    "tools/call",
                    Some(tool_params(name, arguments, false)),
                )
                .await,
            );
        }
    }
    responses
}

pub fn assert_missing_targets(responses: &[Value]) {
    for response in responses {
        assert_eq!(
            response["error"]["code"], -32602,
            "missing target must reject before dispatch: id={}",
            response["id"]
        );
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("notebook_handle"));
    }
}
