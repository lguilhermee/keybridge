//! Inspects only assistant answer fields; tool arguments and metadata stay out.
use bytes::Bytes;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;

use super::super::protocol::ApiProtocol;
use crate::Error;

#[derive(Default)]
struct Reply {
    text: String,
    final_text: String,
    tools: bool,
    refused: bool,
    failed: bool,
}

impl Reply {
    fn content(&mut self, parts: Option<&Value>) {
        for part in parts.and_then(Value::as_array).into_iter().flatten() {
            match part.get("type").and_then(Value::as_str) {
                Some("text" | "output_text") => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        self.final_text.push_str(text);
                        self.final_text.push_str("\n\n");
                    }
                }
                Some("refusal") => self.refused = true,
                Some("tool_use") => self.tools = true,
                _ => {}
            }
        }
    }

    fn item(&mut self, item: &Value) {
        match item.get("type").and_then(Value::as_str) {
            Some("function_call" | "custom_tool_call") => self.tools = true,
            Some("message") => self.content(item.get("content")),
            _ => {}
        }
    }

    fn observe(&mut self, protocol: ApiProtocol, value: &Value) {
        self.failed |= matches!(
            value.get("type").and_then(Value::as_str),
            Some("error" | "response.failed")
        ) || value.get("error").is_some_and(|error| !error.is_null());
        match protocol {
            ApiProtocol::Chat => {
                if let Some(choice) = value.pointer("/choices/0") {
                    let message = choice.get("delta").or_else(|| choice.get("message"));
                    if let Some(message) = message {
                        if let Some(text) = message.get("content").and_then(Value::as_str) {
                            self.text.push_str(text);
                        }
                        self.refused |= message
                            .get("refusal")
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.trim().is_empty());
                        self.tools |= message
                            .get("tool_calls")
                            .and_then(Value::as_array)
                            .is_some_and(|calls| !calls.is_empty());
                    }
                    self.refused |= choice.get("finish_reason").and_then(Value::as_str)
                        == Some("content_filter");
                }
            }
            ApiProtocol::Responses => {
                match value.get("type").and_then(Value::as_str) {
                    Some("response.output_text.delta") => {
                        if let Some(text) = value.get("delta").and_then(Value::as_str) {
                            self.text.push_str(text);
                        }
                    }
                    Some("response.refusal.delta" | "response.refusal.done") => self.refused = true,
                    Some("response.output_item.done") => {
                        if let Some(item) = value.get("item") {
                            self.item(item);
                        }
                    }
                    _ => {}
                }
                let response = value.get("response").unwrap_or(value);
                if let Some(output) = response.get("output").and_then(Value::as_array) {
                    self.final_text.clear();
                    for item in output {
                        self.item(item);
                    }
                }
                self.refused |= response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    == Some("content_filter");
            }
            ApiProtocol::Messages => {
                if value.get("type").and_then(Value::as_str) == Some("content_block_stop") {
                    self.text.push_str("\n\n");
                }
                if value.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                    if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
                        self.text.push_str(text);
                    }
                }
                if let Some(block) = value.get("content_block") {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.text.push_str(text);
                        }
                    }
                    self.tools |= block.get("type").and_then(Value::as_str) == Some("tool_use");
                }
                self.content(value.get("content"));
                self.refused |= value
                    .get("stop_reason")
                    .or_else(|| value.pointer("/delta/stop_reason"))
                    .and_then(Value::as_str)
                    == Some("refusal");
            }
        }
    }

    fn is_refusal(&self) -> bool {
        self.refused
            || (!self.tools
                && !self.failed
                && crate::run::is_refusal(if self.final_text.is_empty() {
                    &self.text
                } else {
                    &self.final_text
                }))
    }
}

pub(super) async fn is_refusal(protocol: ApiProtocol, bytes: &[u8], streaming: bool) -> bool {
    let mut reply = Reply::default();
    if !streaming {
        if let Ok(value) = serde_json::from_slice(bytes) {
            reply.observe(protocol, &value);
        }
    } else {
        let source =
            futures_util::stream::once(async { Ok::<_, Error>(Bytes::copy_from_slice(bytes)) })
                .eventsource();
        futures_util::pin_mut!(source);
        while let Some(event) = source.next().await {
            if let Ok(event) = event {
                if let Ok(value) = serde_json::from_str(&event.data) {
                    reply.observe(protocol, &value);
                }
            }
        }
    }
    reply.is_refusal()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn chat_refusals_and_quoted_examples_use_the_shared_rules() {
        for (message, reason, expected) in [
            (
                json!({"content":"Background.\n\nI cannot help with this request."}),
                "stop",
                true,
            ),
            (json!({"content":null,"refusal":"Declined"}), "stop", true),
            (json!({"content":null}), "content_filter", true),
            (
                json!({"content":"Helpful answer","refusal":""}),
                "stop",
                false,
            ),
            (
                json!({"content":"Example:\n```text\nI cannot help with this request.\n```"}),
                "stop",
                false,
            ),
            (
                json!({"content":"I cannot help with that example.","tool_calls":[{"id":"call_1","function":{"arguments":"I cannot help with this request."}}]}),
                "tool_calls",
                false,
            ),
        ] {
            let complete =
                json!({"choices":[{"message":message,"finish_reason":reason}]}).to_string();
            assert_eq!(
                is_refusal(ApiProtocol::Chat, complete.as_bytes(), false).await,
                expected
            );
            let event = json!({"choices":[{"delta":message,"finish_reason":reason}]}).to_string();
            let sse = format!("data: {event}\n\ndata: [DONE]\n\n");
            assert_eq!(
                is_refusal(ApiProtocol::Chat, sse.as_bytes(), true).await,
                expected
            );
        }
    }
}
