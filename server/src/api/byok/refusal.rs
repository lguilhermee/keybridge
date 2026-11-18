//! Holds a configured primary's response and retries a refusal once.
mod native;

use std::{sync::Arc, time::Duration};

use async_stream::try_stream;
use axum::{
    body::{to_bytes, Body},
    http::header,
    response::Response,
};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{
    model::{ModelInvocation, ModelSpec},
    protocol::{FinishReason, ModelEvent, Protocol, ProtocolStream},
    Error, Result,
};

use super::{protocol::ApiProtocol, ApiState};

/// Everything needed to retry the original input with the fallback's settings.
pub(super) struct Fallback {
    state: ApiState,
    protocol: ApiProtocol,
    body: Value,
    model_id: String,
}

impl Fallback {
    pub(super) fn new(
        state: ApiState,
        protocol: ApiProtocol,
        body: Value,
        model_id: String,
    ) -> Self {
        Self {
            state,
            protocol,
            body,
            model_id,
        }
    }

    async fn respond(self) -> Result<Response> {
        let mut parsed = super::protocol::parse(self.protocol, &self.body)?;
        // Keep history, instructions, tools and the client's public model name.
        // Discard primary effort, Fast tier, token limits and extra parameters.
        parsed.request.model = ModelSpec::new(&self.model_id);
        tracing::warn!(to = %self.model_id, "external API primary refused; using its refusal model");
        super::respond(&self.state, parsed, self.protocol, None).await
    }

    pub(super) async fn inspect_native(self, response: Response) -> Result<Response> {
        let (mut parts, body) = response.into_parts();
        let streaming = self
            .body
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !streaming {
            let bytes = to_bytes(body, usize::MAX)
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
            if native::is_refusal(self.protocol, &bytes, false).await {
                return self.respond().await;
            }
            return Ok(Response::from_parts(parts, Body::from(bytes)));
        }

        // No primary content, tool calls or completion markers reach the harness
        // until the decision. Comments keep the connection alive during the hold.
        parts.headers.remove(header::CONTENT_LENGTH);
        let output = try_stream! {
            let mut upstream = body.into_data_stream();
            let mut bytes = BytesMut::new();
            let mut keepalive = tokio::time::interval(Duration::from_secs(10));
            keepalive.tick().await;
            loop {
                let chunk = tokio::select! {
                    chunk = upstream.next() => chunk,
                    _ = keepalive.tick() => {
                        yield Bytes::from_static(b": keybridge refusal check\n\n");
                        continue;
                    },
                };
                let Some(chunk) = chunk else { break };
                bytes.extend_from_slice(&chunk.map_err(|error| Error::Provider(error.to_string()))?);
            }
            if native::is_refusal(self.protocol, &bytes, true).await {
                let response = self.respond().await?;
                let mut answer = response.into_body().into_data_stream();
                while let Some(chunk) = answer.next().await {
                    yield chunk.map_err(|error| Error::Provider(error.to_string()))?;
                }
            } else {
                yield bytes.freeze();
            }
        };
        let output = output.map(|chunk: Result<Bytes>| chunk);
        Ok(Response::from_parts(parts, Body::from_stream(output)))
    }
}

/// The converted route uses the same decision, without parsing native JSON/SSE.
pub(super) fn stream(
    protocol: Arc<dyn Protocol>,
    mut invocation: ModelInvocation,
    cancellation: CancellationToken,
    fallback: Option<String>,
) -> ProtocolStream {
    let Some(fallback) = fallback else {
        return protocol.stream(invocation, cancellation);
    };
    Box::pin(try_stream! {
        let mut primary = protocol.stream(invocation.clone(), cancellation.clone());
        let mut held = Vec::new();
        let mut text = String::new();
        let mut tools = false;
        let mut refused = false;
        loop {
            let event = tokio::select! {
                _ = cancellation.cancelled() => return,
                event = primary.next() => event,
            };
            let Some(event) = event else { break };
            let event = event?;
            match &event {
                ModelEvent::TextDelta(delta) => text.push_str(delta),
                ModelEvent::TextEnd => text.push_str("\n\n"),
                ModelEvent::ToolCallStart { .. } => tools = true,
                ModelEvent::Done(FinishReason::Refusal(_)) => refused = true,
                _ => {},
            }
            held.push(event);
        }
        if refused || (!tools && crate::run::is_refusal(&text)) {
            invocation.call_id = format!("external-api:{}", uuid::Uuid::new_v4());
            invocation.provider_call_index += 1;
            invocation.request.model = ModelSpec::new(&fallback);
            tracing::warn!(to = %fallback, "external API primary refused; using its refusal model");
            let mut answer = protocol.stream(invocation, cancellation.clone());
            loop {
                let event = tokio::select! {
                    _ = cancellation.cancelled() => return,
                    event = answer.next() => event,
                };
                let Some(event) = event else { break };
                yield event?;
            }
        } else {
            for event in held { yield event; }
        }
    })
}
