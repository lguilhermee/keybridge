use std::collections::HashMap;

use base64::Engine;
use serde_json::Value;

use crate::{
    model::{
        ContentPart, ModelRequest, ModelSpec, ProjectedContent, ProjectedMessage, PromptSpec,
        ProtocolType, Role, ToolCallContent, ToolDefinition, ToolResultContent,
    },
    Error, Result,
};

#[derive(Clone, Copy, Debug)]
pub(super) enum ApiProtocol {
    Chat,
    Responses,
    Messages,
}

impl ApiProtocol {
    pub(super) fn protocol_type(self) -> ProtocolType {
        match self {
            Self::Chat => ProtocolType::OpenAiChat,
            Self::Responses => ProtocolType::OpenAiResponses,
            Self::Messages => ProtocolType::Anthropic,
        }
    }
}

/// Flat tool name offered to the model -> the Responses `(namespace, name)` it stands for.
pub(super) type NamespacedTools = HashMap<String, (String, String)>;

pub(super) struct ParsedRequest {
    pub public_model_id: String,
    pub request: ModelRequest,
    pub stream: bool,
    pub namespaced_tools: NamespacedTools,
}

pub(super) fn parse(protocol: ApiProtocol, body: &Value) -> Result<ParsedRequest> {
    let public_model_id = required_string(body, "model")?.to_owned();
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut prompt = PromptSpec {
        instructions: String::new(),
        tools: Vec::new(),
    };
    let mut history = Vec::new();
    let mut model = ModelSpec::new(&public_model_id);
    let mut namespaced_tools = NamespacedTools::new();
    match protocol {
        ApiProtocol::Chat => {
            parse_chat_messages(body.get("messages"), &mut prompt, &mut history)?;
            parse_tools(body.get("tools"), protocol, &mut prompt)?;
            model.max_output_tokens = body
                .get("max_completion_tokens")
                .or_else(|| body.get("max_tokens"))
                .and_then(Value::as_u64);
        }
        ApiProtocol::Responses => {
            prompt.instructions = body
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            match body.get("input") {
                Some(Value::String(text)) => history.push(text_message(0, Role::User, text)),
                Some(input) => parse_responses_input(input, &mut prompt, &mut history)?,
                None => return Err(Error::Protocol("input is required".into())),
            }
            parse_responses_tools(body.get("tools"), &mut prompt, &mut namespaced_tools)?;
            model.max_output_tokens = body.get("max_output_tokens").and_then(Value::as_u64);
        }
        ApiProtocol::Messages => {
            prompt.instructions = text_content(body.get("system")).unwrap_or_default();
            parse_anthropic_messages(body.get("messages"), &mut history)?;
            parse_tools(body.get("tools"), protocol, &mut prompt)?;
            model.max_output_tokens = body.get("max_tokens").and_then(Value::as_u64);
        }
    }
    if history.is_empty() {
        return Err(Error::Protocol(
            "at least one input message is required".into(),
        ));
    }
    Ok(ParsedRequest {
        public_model_id,
        request: ModelRequest {
            prompt,
            model,
            history,
        },
        stream,
        namespaced_tools,
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| Error::Protocol(format!("{field} is required")))
}

fn text_message(index: usize, role: Role, text: &str) -> ProjectedMessage {
    ProjectedMessage {
        message_id: format!("external:{index}"),
        role,
        content: ProjectedContent::Parts(vec![ContentPart::Text { text: text.into() }]),
    }
}

fn text_content(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| {
                    part.as_str()
                        .or_else(|| part.get("text").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

fn parse_parts(value: Option<&Value>) -> Result<Vec<ContentPart>> {
    let value = value.ok_or_else(|| Error::Protocol("message content is required".into()))?;
    if let Some(text) = value.as_str() {
        return Ok(vec![ContentPart::Text { text: text.into() }]);
    }
    let array = value
        .as_array()
        .ok_or_else(|| Error::Protocol("message content must be text or an array".into()))?;
    array
        .iter()
        .map(|part| {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
            match kind {
                "text" | "input_text" | "output_text" => Ok(ContentPart::Text {
                    text: required_string(part, "text")?.into(),
                }),
                "image_url" | "input_image" | "image" => {
                    let url = part
                        .pointer("/image_url/url")
                        .or_else(|| part.get("image_url"))
                        .or_else(|| part.pointer("/source/data"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::Protocol("image data URL is required".into()))?;
                    let data_url = if url.starts_with("data:") {
                        url.to_owned()
                    } else if let Some(mime) =
                        part.pointer("/source/media_type").and_then(Value::as_str)
                    {
                        format!("data:{mime};base64,{url}")
                    } else {
                        return Err(Error::Protocol(
                            "only base64 image data URLs are supported".into(),
                        ));
                    };
                    let (prefix, encoded) = data_url
                        .split_once(',')
                        .ok_or_else(|| Error::Protocol("invalid image data URL".into()))?;
                    let mime_type = prefix
                        .strip_prefix("data:")
                        .and_then(|prefix| prefix.strip_suffix(";base64"))
                        .ok_or_else(|| Error::Protocol("invalid image data URL".into()))?;
                    let data = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|_| Error::Protocol("invalid base64 image".into()))?;
                    Ok(ContentPart::Image {
                        mime_type: mime_type.into(),
                        data,
                    })
                }
                _ => Err(Error::Protocol(format!("unsupported content type: {kind}"))),
            }
        })
        .collect()
}

fn parse_chat_messages(
    value: Option<&Value>,
    prompt: &mut PromptSpec,
    history: &mut Vec<ProjectedMessage>,
) -> Result<()> {
    let messages = value
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Protocol("messages must be an array".into()))?;
    for (index, message) in messages.iter().enumerate() {
        let role = required_string(message, "role")?;
        match role {
            "system" | "developer" => {
                if !history.is_empty() {
                    return Err(Error::Protocol(
                        "system messages must precede conversation messages".into(),
                    ));
                }
                let text = text_content(message.get("content"))
                    .ok_or_else(|| Error::Protocol("system content must be text".into()))?;
                if !prompt.instructions.is_empty() {
                    prompt.instructions.push('\n');
                }
                prompt.instructions.push_str(&text);
            }
            "user" => history.push(ProjectedMessage {
                message_id: format!("external:{index}"),
                role: Role::User,
                content: ProjectedContent::Parts(parse_parts(message.get("content"))?),
            }),
            "assistant" => {
                let text = text_content(message.get("content")).unwrap_or_default();
                let calls = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|calls| {
                        calls
                            .iter()
                            .enumerate()
                            .map(|(index, call)| {
                                let function = call.get("function").ok_or_else(|| {
                                    Error::Protocol("tool function is required".into())
                                })?;
                                let arguments = required_string(function, "arguments")?;
                                Ok(ToolCallContent {
                                    index,
                                    call_id: required_string(call, "id")?.into(),
                                    name: required_string(function, "name")?.into(),
                                    arguments: serde_json::from_str(arguments)?,
                                })
                            })
                            .collect::<Result<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                history.push(ProjectedMessage {
                    message_id: format!("external:{index}"),
                    role: Role::Assistant,
                    content: ProjectedContent::Assistant {
                        text,
                        thinking: String::new(),
                        replay_state: None,
                        calls,
                    },
                });
            }
            "tool" => history.push(ProjectedMessage {
                message_id: format!("external:{index}"),
                role: Role::Tool,
                content: ProjectedContent::ToolResult(ToolResultContent {
                    call_id: required_string(message, "tool_call_id")?.into(),
                    name: message
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| {
                            tool_name(
                                history,
                                message
                                    .get("tool_call_id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default(),
                            )
                        })
                        .unwrap_or_else(|| "tool".into()),
                    content: text_content(message.get("content")).unwrap_or_default(),
                    is_error: false,
                    image: None,
                    provider_parts: Vec::new(),
                }),
            }),
            _ => return Err(Error::Protocol(format!("unsupported role: {role}"))),
        }
    }
    Ok(())
}

fn parse_responses_input(
    value: &Value,
    prompt: &mut PromptSpec,
    history: &mut Vec<ProjectedMessage>,
) -> Result<()> {
    let items = value
        .as_array()
        .ok_or_else(|| Error::Protocol("input must be text or an array".into()))?;
    for (index, item) in items.iter().enumerate() {
        match item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message")
        {
            "function_call_output" => {
                let call_id = required_string(item, "call_id")?;
                let output = item.get("output");
                // An array output can carry images, such as a screenshot the tool returned.
                let provider_parts = parse_parts(output)
                    .ok()
                    .filter(|parts| {
                        parts
                            .iter()
                            .any(|part| matches!(part, ContentPart::Image { .. }))
                    })
                    .unwrap_or_default();
                history.push(ProjectedMessage {
                    message_id: format!("external:{index}"),
                    role: Role::Tool,
                    content: ProjectedContent::ToolResult(ToolResultContent {
                        call_id: call_id.into(),
                        name: tool_name(history, call_id).unwrap_or_else(|| "tool".into()),
                        content: text_content(output).unwrap_or_default(),
                        is_error: false,
                        image: None,
                        provider_parts,
                    }),
                });
            }
            "function_call" => {
                let name = required_string(item, "name")?;
                let name = match item.get("namespace").and_then(Value::as_str) {
                    Some(namespace) if !namespace.is_empty() => flat_tool_name(namespace, name),
                    _ => name.to_owned(),
                };
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = if arguments.trim().is_empty() {
                    Value::Object(Default::default())
                } else {
                    serde_json::from_str(arguments)?
                };
                let call_id = required_string(item, "call_id")?.to_owned();
                // One model turn is one assistant message: its text, then every call it made.
                if let Some(ProjectedMessage {
                    content: ProjectedContent::Assistant { calls, .. },
                    ..
                }) = history.last_mut()
                {
                    calls.push(ToolCallContent {
                        index: calls.len(),
                        call_id,
                        name,
                        arguments,
                    });
                } else {
                    history.push(ProjectedMessage {
                        message_id: format!("external:{index}"),
                        role: Role::Assistant,
                        content: ProjectedContent::Assistant {
                            text: String::new(),
                            thinking: String::new(),
                            replay_state: None,
                            calls: vec![ToolCallContent {
                                index: 0,
                                call_id,
                                name,
                                arguments,
                            }],
                        },
                    });
                }
            }
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                match role {
                    // Leading system and developer messages are the caller's instructions.
                    "system" | "developer" if history.is_empty() => {
                        let text = text_content(item.get("content"))
                            .ok_or_else(|| Error::Protocol("system content must be text".into()))?;
                        if !prompt.instructions.is_empty() {
                            prompt.instructions.push_str("\n\n");
                        }
                        prompt.instructions.push_str(&text);
                    }
                    "user" | "system" | "developer" => history.push(ProjectedMessage {
                        message_id: format!("external:{index}"),
                        role: Role::User,
                        content: ProjectedContent::Parts(parse_parts(item.get("content"))?),
                    }),
                    "assistant" => history.push(ProjectedMessage {
                        message_id: format!("external:{index}"),
                        role: Role::Assistant,
                        content: ProjectedContent::Assistant {
                            text: text_content(item.get("content")).unwrap_or_default(),
                            thinking: String::new(),
                            replay_state: None,
                            calls: Vec::new(),
                        },
                    }),
                    _ => return Err(Error::Protocol(format!("unsupported role: {role}"))),
                }
            }
            // Reasoning, hosted tool calls, and compaction items are private to the model
            // that produced them; another model cannot replay them.
            _ => {}
        }
    }
    Ok(())
}

fn parse_anthropic_messages(
    value: Option<&Value>,
    history: &mut Vec<ProjectedMessage>,
) -> Result<()> {
    let messages = value
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Protocol("messages must be an array".into()))?;
    for (index, message) in messages.iter().enumerate() {
        let role = required_string(message, "role")?;
        let content = message
            .get("content")
            .ok_or_else(|| Error::Protocol("content is required".into()))?;
        if let Some(blocks) = content.as_array() {
            let mut text_parts = Vec::new();
            let mut calls = Vec::new();
            for (block_index, block) in blocks.iter().enumerate() {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => calls.push(ToolCallContent {
                        index: calls.len(),
                        call_id: required_string(block, "id")?.into(),
                        name: required_string(block, "name")?.into(),
                        arguments: block
                            .get("input")
                            .cloned()
                            .unwrap_or(Value::Object(Default::default())),
                    }),
                    Some("tool_result") => {
                        if role != "user" {
                            return Err(Error::Protocol(
                                "tool_result must be in a user message".into(),
                            ));
                        }
                        if !text_parts.is_empty() {
                            history.push(ProjectedMessage {
                                message_id: format!("external:{index}:{block_index}:text"),
                                role: Role::User,
                                content: ProjectedContent::Parts(std::mem::take(&mut text_parts)),
                            });
                        }
                        let call_id = required_string(block, "tool_use_id")?;
                        history.push(ProjectedMessage {
                            message_id: format!("external:{index}:{block_index}:tool"),
                            role: Role::Tool,
                            content: ProjectedContent::ToolResult(ToolResultContent {
                                call_id: call_id.into(),
                                name: tool_name(history, call_id).unwrap_or_else(|| "tool".into()),
                                content: text_content(block.get("content")).unwrap_or_default(),
                                is_error: block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                image: None,
                                provider_parts: Vec::new(),
                            }),
                        });
                    }
                    _ => text_parts.extend(parse_parts(Some(&Value::Array(vec![block.clone()])))?),
                }
            }
            if role == "assistant" {
                let text = text_parts
                    .iter()
                    .filter_map(|part| {
                        if let ContentPart::Text { text } = part {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("");
                history.push(ProjectedMessage {
                    message_id: format!("external:{index}"),
                    role: Role::Assistant,
                    content: ProjectedContent::Assistant {
                        text,
                        thinking: String::new(),
                        replay_state: None,
                        calls,
                    },
                });
            } else if !text_parts.is_empty() {
                history.push(ProjectedMessage {
                    message_id: format!("external:{index}"),
                    role: Role::User,
                    content: ProjectedContent::Parts(text_parts),
                });
            }
        } else {
            let role = match role {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                _ => return Err(Error::Protocol(format!("unsupported role: {role}"))),
            };
            history.push(ProjectedMessage {
                message_id: format!("external:{index}"),
                role,
                content: ProjectedContent::Parts(parse_parts(Some(content))?),
            });
        }
    }
    Ok(())
}

fn parse_tools(
    value: Option<&Value>,
    protocol: ApiProtocol,
    prompt: &mut PromptSpec,
) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let tools = value
        .as_array()
        .ok_or_else(|| Error::Protocol("tools must be an array".into()))?;
    for tool in tools {
        let function = if matches!(protocol, ApiProtocol::Chat) {
            tool.get("function").unwrap_or(tool)
        } else {
            tool
        };
        let name = required_string(function, "name")?.to_owned();
        prompt.tools.push(tool_definition(function, name));
    }
    Ok(())
}

fn parse_responses_tools(
    value: Option<&Value>,
    prompt: &mut PromptSpec,
    namespaced_tools: &mut NamespacedTools,
) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let tools = value
        .as_array()
        .ok_or_else(|| Error::Protocol("tools must be an array".into()))?;
    for tool in tools {
        match tool
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("function")
        {
            "function" => {
                let name = required_string(tool, "name")?.to_owned();
                prompt.tools.push(tool_definition(tool, name));
            }
            "namespace" => {
                let namespace = required_string(tool, "name")?;
                let nested = tool.get("tools").and_then(Value::as_array);
                for function in nested.into_iter().flatten() {
                    if function.get("type").and_then(Value::as_str) != Some("function") {
                        continue;
                    }
                    let name = required_string(function, "name")?;
                    let flat = flat_tool_name(namespace, name);
                    namespaced_tools.insert(flat.clone(), (namespace.to_owned(), name.to_owned()));
                    prompt.tools.push(tool_definition(function, flat));
                }
            }
            // Hosted and freeform tools (web_search, custom, ...) have no function
            // schema that another model could call.
            _ => {}
        }
    }
    Ok(())
}

fn tool_definition(function: &Value, name: String) -> ToolDefinition {
    ToolDefinition {
        name,
        description: function
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        parameters: function
            .get("parameters")
            .or_else(|| function.get("input_schema"))
            .cloned()
            .unwrap_or(serde_json::json!({"type":"object","properties":{}})),
    }
}

/// Models only see flat function names, so a Responses namespace is folded into the name.
fn flat_tool_name(namespace: &str, name: &str) -> String {
    if namespace.ends_with('_') {
        format!("{namespace}{name}")
    } else {
        format!("{namespace}__{name}")
    }
}

fn tool_name(history: &[ProjectedMessage], call_id: &str) -> Option<String> {
    history
        .iter()
        .rev()
        .find_map(|message| match &message.content {
            ProjectedContent::Assistant { calls, .. } => calls
                .iter()
                .find(|call| call.call_id == call_id)
                .map(|call| call.name.clone()),
            _ => None,
        })
}
