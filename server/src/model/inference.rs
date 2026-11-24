//! Defines provider-independent model requests and streaming responses.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{ModelSpec, ProjectedContent, ProjectedMessage, ToolDefinition};

const PROVIDER_TOOL_CALL_ID_MAX_CHARS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptSpec {
    pub instructions: String,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelRequest {
    pub prompt: PromptSpec,
    pub model: ModelSpec,
    pub history: Vec<ProjectedMessage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelInvocation {
    pub call_id: String,
    pub run_id: String,
    pub conversation_id: String,
    pub provider_call_index: u64,
    pub request: ModelRequest,
}

pub(crate) fn normalize_provider_tool_call_ids(history: &mut [ProjectedMessage]) {
    for message in history {
        match &mut message.content {
            ProjectedContent::Assistant { calls, .. } => {
                for call in calls {
                    normalize_tool_call_id(&mut call.call_id);
                }
            }
            ProjectedContent::ToolResult(result) => {
                normalize_tool_call_id(&mut result.call_id);
            }
            ProjectedContent::Parts(_) => {}
        }
    }
}

fn normalize_tool_call_id(call_id: &mut String) {
    if !call_id.is_empty()
        && call_id.len() <= PROVIDER_TOOL_CALL_ID_MAX_CHARS
        && call_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return;
    }
    let digest = format!("{:x}", Sha256::digest(call_id.as_bytes()));
    *call_id = format!("call_{}", &digest[..PROVIDER_TOOL_CALL_ID_MAX_CHARS - 5]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Role, ToolCallContent, ToolResultContent};
    use serde_json::json;

    #[test]
    fn resumed_tool_ids_are_valid_and_keep_calls_paired_with_results() {
        let ids = [
            "cursor:read/file",
            "cursor:read?file",
            "cursor-read_file",
            "long-id-with-a-shared-prefix-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-a",
            "long-id-with-a-shared-prefix-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-b",
        ];
        let history = ids
            .iter()
            .flat_map(|id| {
                [
                    ProjectedMessage {
                        message_id: format!("assistant:{id}"),
                        role: Role::Assistant,
                        content: ProjectedContent::Assistant {
                            text: String::new(),
                            thinking: String::new(),
                            replay_state: None,
                            calls: vec![ToolCallContent {
                                index: 0,
                                call_id: (*id).into(),
                                name: "Read".into(),
                                arguments: json!({}),
                            }],
                        },
                    },
                    ProjectedMessage {
                        message_id: format!("result:{id}"),
                        role: Role::Tool,
                        content: ProjectedContent::ToolResult(ToolResultContent {
                            call_id: (*id).into(),
                            name: "Read".into(),
                            content: "ok".into(),
                            is_error: false,
                            image: None,
                            provider_parts: vec![],
                        }),
                    },
                ]
            })
            .collect::<Vec<_>>();
        let mut normalized = history.clone();
        normalize_provider_tool_call_ids(&mut normalized);
        let mut normalized_again = history;
        normalize_provider_tool_call_ids(&mut normalized_again);
        assert_eq!(normalized, normalized_again);

        let mut normalized_ids = Vec::new();
        for pair in normalized.as_chunks::<2>().0 {
            let ProjectedContent::Assistant { calls, .. } = &pair[0].content else {
                panic!("expected assistant");
            };
            let ProjectedContent::ToolResult(result) = &pair[1].content else {
                panic!("expected tool result");
            };
            let id = &calls[0].call_id;
            assert_eq!(id, &result.call_id);
            assert!(!id.is_empty());
            assert!(id.len() <= PROVIDER_TOOL_CALL_ID_MAX_CHARS);
            assert!(id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'));
            normalized_ids.push(id.clone());
        }
        assert_eq!(normalized_ids[2], ids[2]);
        assert_eq!(
            normalized_ids.len(),
            normalized_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
        );
    }
}
