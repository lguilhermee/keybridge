//! Executes and consumes one streaming provider call.
use std::{collections::btree_map::Entry, collections::BTreeMap, time::Instant};

use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    model::{normalize_tool_name, ProtocolReplayState, ToolCall, Usage},
    protocol::{FinishReason, ModelEvent, ProtocolStream},
};

use super::{refusal_reply::ReplyHold, RunEvent, RunFailure};

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCycleResult {
    pub model_call_id: String,
    pub text: String,
    pub reasoning: String,
    pub replay_state: Option<ProtocolReplayState>,
    pub calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: FinishReason,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCycleFailure {
    pub failure: RunFailure,
    pub partial_text: String,
    pub partial_reasoning: String,
    pub usage: Option<Usage>,
    pub kind: FailureKind,
}

/// What a failed model call means for the next attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// The model declined on policy grounds; the same request gets the same answer.
    Refusal,
    /// The provider rejected the request or the account: 4xx, rate limit, or quota.
    Rejected,
    /// Transport or server trouble that a later attempt can clear.
    Temporary,
    /// Nothing another attempt can fix: store, client, or a cut-off answer.
    Final,
}

struct OpenTool {
    call: ToolCall,
    ended: bool,
}

/// `watch_refusals` holds the reply's text back until it is known whether the
/// model refuses in its own words; a refusing reply then fails the call as a
/// refusal without being shown.
pub async fn consume_model_cycle(
    mut stream: ProtocolStream,
    client: &mpsc::Sender<RunEvent>,
    cancellation: &CancellationToken,
    watch_refusals: bool,
) -> std::result::Result<ModelCycleResult, Box<ModelCycleFailure>> {
    let mut model_call_id = None;
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut text_open = false;
    let mut hold = ReplyHold::new(watch_refusals);
    let mut thinking_started = None::<Instant>;
    let mut tools = BTreeMap::<usize, OpenTool>::new();
    let mut call_ids = std::collections::HashSet::new();
    let mut replay_state = None;
    let mut usage = None;
    let mut finish = None;

    loop {
        let next = tokio::select! {
            // Let the provider observe cancellation for its cleanup, but never
            // forward a buffered event after Stop (even when next() stays ready).
            biased;
            next = stream.next() => next,
            _ = cancellation.cancelled() => {
                interrupt_cycle(
                    client,
                    text_open && !hold.has_held_text(),
                    thinking_started.take(),
                );
                return Err(failure(
                    RunFailure::Client("run was cancelled".into()),
                    text,
                    reasoning,
                    usage,
                ));
            }
        };
        if cancellation.is_cancelled() {
            interrupt_cycle(
                client,
                text_open && !hold.has_held_text(),
                thinking_started.take(),
            );
            return Err(failure(
                RunFailure::Client("run was cancelled".into()),
                text,
                reasoning,
                usage,
            ));
        }
        let Some(next) = next else {
            break;
        };
        let event = match next {
            Ok(event) => event,
            Err(error) => {
                return Err(failure(error.into(), text, reasoning, usage));
            }
        };
        if finish.is_some() {
            return Err(failure(
                RunFailure::Protocol("protocol emitted an event after Done".into()),
                text,
                reasoning,
                usage,
            ));
        }
        let result = match event {
            ModelEvent::Start { model_call_id: id } => {
                if model_call_id.replace(id).is_some() {
                    Err("protocol emitted duplicate Start")
                } else {
                    Ok(())
                }
            }
            ModelEvent::TextStart => {
                if model_call_id.is_none() {
                    Err("protocol emitted content before Start")
                } else if text_open {
                    Err("protocol emitted duplicate TextStart")
                } else {
                    text_open = true;
                    let events = hold.text(RunEvent::TextStart);
                    send_all(client, cancellation, events).await
                }
            }
            ModelEvent::TextDelta(delta) => {
                if !text_open {
                    Err("protocol emitted TextDelta before TextStart")
                } else {
                    text.push_str(&delta);
                    let events = hold.text(RunEvent::TextDelta(delta));
                    send_all(client, cancellation, events).await
                }
            }
            ModelEvent::TextEnd => {
                if !text_open {
                    Err("protocol emitted TextEnd before TextStart")
                } else {
                    text_open = false;
                    let events = hold.text(RunEvent::TextEnd);
                    send_all(client, cancellation, events).await
                }
            }
            ModelEvent::ThinkingStart => {
                if model_call_id.is_none() {
                    Err("protocol emitted content before Start")
                } else if thinking_started.replace(Instant::now()).is_some() {
                    Err("protocol emitted duplicate ThinkingStart")
                } else {
                    send(client, cancellation, RunEvent::ThinkingStart).await
                }
            }
            ModelEvent::ThinkingDelta(delta) => {
                if thinking_started.is_none() {
                    Err("protocol emitted ThinkingDelta before ThinkingStart")
                } else {
                    reasoning.push_str(&delta);
                    send(client, cancellation, RunEvent::ThinkingDelta(delta)).await
                }
            }
            ModelEvent::ThinkingEnd => {
                if let Some(started) = thinking_started.take() {
                    send(
                        client,
                        cancellation,
                        RunEvent::ThinkingEnd {
                            duration: started.elapsed(),
                        },
                    )
                    .await
                } else {
                    Err("protocol emitted ThinkingEnd before ThinkingStart")
                }
            }
            ModelEvent::ToolCallStart {
                index,
                call_id,
                name,
            } => {
                let name = normalize_tool_name(&name);
                let Some(model_call_id) = model_call_id.as_ref() else {
                    return Err(failure(
                        RunFailure::Protocol("protocol emitted content before Start".into()),
                        text,
                        reasoning,
                        usage,
                    ));
                };
                match tools.entry(index) {
                    Entry::Occupied(_) => Err("provider reused a tool index"),
                    Entry::Vacant(_) if !call_ids.insert(call_id.clone()) => {
                        Err("provider reused a tool call_id")
                    }
                    Entry::Vacant(entry) => {
                        entry.insert(OpenTool {
                            call: ToolCall {
                                index,
                                call_id: call_id.clone(),
                                model_call_id: model_call_id.clone(),
                                name: name.clone(),
                                arguments_text: String::new(),
                                arguments: serde_json::Value::Null,
                                argument_error: None,
                            },
                            ended: false,
                        });
                        // A reply that calls tools is not a refusal.
                        let mut events = hold.release();
                        events.push(RunEvent::ToolCallStart {
                            index,
                            call_id,
                            name,
                            model_call_id: model_call_id.clone(),
                        });
                        send_all(client, cancellation, events).await
                    }
                }
            }
            ModelEvent::ToolCallArgumentsDelta { index, delta } => match tools.get_mut(&index) {
                Some(tool) if !tool.ended => {
                    tool.call.arguments_text.push_str(&delta);
                    send(
                        client,
                        cancellation,
                        RunEvent::ToolCallArgumentsDelta { index, delta },
                    )
                    .await
                }
                Some(_) => Err("protocol emitted tool arguments after ToolCallEnd"),
                None => Err("protocol emitted tool arguments for an unknown index"),
            },
            ModelEvent::ToolCallEnd { index } => match tools.get_mut(&index) {
                Some(tool) if !tool.ended => {
                    let arguments = if tool.call.arguments_text.trim().is_empty() {
                        Ok(serde_json::json!({}))
                    } else {
                        serde_json::from_str(&tool.call.arguments_text)
                    };
                    match arguments {
                        Ok(arguments) if arguments.is_object() => {
                            tool.call.arguments = arguments;
                        }
                        Ok(_) => {
                            tool.call.arguments = serde_json::json!({});
                            tool.call.argument_error = Some(format!(
                                "{} arguments must be a JSON object",
                                tool.call.name
                            ));
                        }
                        Err(error) => {
                            tool.call.arguments = serde_json::json!({});
                            tool.call.argument_error = Some(format!(
                                "{} arguments are not valid JSON: {error}",
                                tool.call.name
                            ));
                        }
                    }
                    tool.ended = true;
                    send(client, cancellation, RunEvent::ToolCallEnd { index }).await
                }
                Some(_) => Err("protocol emitted duplicate ToolCallEnd"),
                None => Err("provider ended an unknown tool index"),
            },
            ModelEvent::ProtocolReplayState(state) => {
                if replay_state.replace(state).is_some() {
                    Err("protocol emitted duplicate ProtocolReplayState")
                } else {
                    Ok(())
                }
            }
            ModelEvent::Usage(value) => {
                if usage.replace(value).is_some() {
                    Err("protocol emitted duplicate Usage")
                } else if send(client, cancellation, RunEvent::Usage(value))
                    .await
                    .is_err()
                {
                    return Err(failure(
                        RunFailure::Client("client event channel closed".into()),
                        text,
                        reasoning,
                        usage,
                    ));
                } else {
                    Ok(())
                }
            }
            ModelEvent::Done(reason) => {
                if model_call_id.is_none() {
                    Err("protocol emitted content before Start")
                } else if text_open
                    || thinking_started.is_some()
                    || tools.values().any(|tool| !tool.ended)
                {
                    Err("protocol emitted Done with an open content block")
                } else {
                    finish = Some(reason);
                    Ok(())
                }
            }
        };
        if let Err(message) = result {
            if cancellation.is_cancelled() {
                interrupt_cycle(
                    client,
                    text_open && !hold.has_held_text(),
                    thinking_started.take(),
                );
                return Err(failure(
                    RunFailure::Client("run was cancelled".into()),
                    text,
                    reasoning,
                    usage,
                ));
            }
            return Err(failure(
                RunFailure::Protocol(message.into()),
                text,
                reasoning,
                usage,
            ));
        }
    }

    let Some(finish_reason) = finish else {
        return Err(failure(
            RunFailure::Provider("provider stream reached EOF before Done".into()),
            text,
            reasoning,
            usage,
        ));
    };
    let calls = tools
        .into_values()
        .map(|tool| tool.call)
        .collect::<Vec<_>>();
    // Text already sent stays on screen; the refused answer is never saved.
    if let FinishReason::Refusal(refusal) = &finish_reason {
        return Err(failure(
            RunFailure::Refusal(refusal.to_string()),
            text,
            reasoning,
            usage,
        ));
    }
    // The reply refused in its own words; none of it was shown.
    if finish_reason == FinishReason::Stop && hold.is_refusing(&text) {
        return Err(failure(
            RunFailure::Refusal("declined the request in its reply".into()),
            text,
            reasoning,
            usage,
        ));
    }
    if send_all(client, cancellation, hold.release())
        .await
        .is_err()
    {
        return Err(failure(
            RunFailure::Client("client event channel closed".into()),
            text,
            reasoning,
            usage,
        ));
    }
    if finish_reason == FinishReason::Length {
        return Err(terminal_failure(
            RunFailure::Provider("model stopped before completing the response".into()),
            text,
            reasoning,
            usage,
        ));
    }
    let has_tool_calls = !calls.is_empty();
    if matches!(finish_reason, FinishReason::ToolUse) != has_tool_calls {
        return Err(failure(
            RunFailure::Protocol("finish reason and tool calls disagree".into()),
            text,
            reasoning,
            usage,
        ));
    }
    let model_call_id = model_call_id.ok_or_else(|| {
        failure(
            RunFailure::Protocol("provider completed without Start".into()),
            text.clone(),
            reasoning.clone(),
            usage,
        )
    })?;
    Ok(ModelCycleResult {
        model_call_id,
        text,
        reasoning,
        replay_state,
        calls,
        usage,
        finish_reason,
    })
}

async fn send(
    client: &mpsc::Sender<RunEvent>,
    cancellation: &CancellationToken,
    event: RunEvent,
) -> std::result::Result<(), &'static str> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("run was cancelled"),
        result = client.send(event) => result.map_err(|_| "client event channel closed"),
    }
}

async fn send_all(
    client: &mpsc::Sender<RunEvent>,
    cancellation: &CancellationToken,
    events: Vec<RunEvent>,
) -> std::result::Result<(), &'static str> {
    for event in events {
        send(client, cancellation, event).await?;
    }
    Ok(())
}

fn interrupt_cycle(
    client: &mpsc::Sender<RunEvent>,
    text_open: bool,
    thinking_started: Option<Instant>,
) {
    if text_open {
        let _ = client.try_send(RunEvent::TextEnd);
    }
    if let Some(started) = thinking_started {
        let _ = client.try_send(RunEvent::ThinkingEnd {
            duration: started.elapsed(),
        });
    }
}

fn failure(
    failure: RunFailure,
    partial_text: String,
    partial_reasoning: String,
    usage: Option<Usage>,
) -> Box<ModelCycleFailure> {
    let kind = match &failure {
        RunFailure::Refusal(_) => FailureKind::Refusal,
        RunFailure::Provider(message) if is_rejected_request(message) => FailureKind::Rejected,
        RunFailure::Protocol(_) | RunFailure::Provider(_) => FailureKind::Temporary,
        RunFailure::Store(_) | RunFailure::Client(_) => FailureKind::Final,
    };
    Box::new(ModelCycleFailure {
        failure,
        partial_text,
        partial_reasoning,
        usage,
        kind,
    })
}

/// Request rejections and rate limits must reach the user immediately instead
/// of multiplying retries in both the Run loop and Cursor. Provider failures
/// are formatted as `<label> <status>: <body>`, so only the head before the body
/// is inspected. Connect providers report named status codes in that same head.
/// Transport failures and temporary server errors retain their retry behavior.
pub(crate) fn is_rejected_request(message: &str) -> bool {
    let head = message.split_once(": ").map_or(message, |(head, _)| head);
    head.split_whitespace().any(|token| {
        matches!(
            token,
            "permission_denied"
                | "unauthenticated"
                | "invalid_argument"
                | "not_found"
                | "failed_precondition"
                | "out_of_range"
                | "unimplemented"
                | "resource_exhausted"
        ) || (token.len() == 3
            && token.starts_with('4')
            && token.bytes().all(|byte| byte.is_ascii_digit())
            && !matches!(token, "408" | "425"))
    })
}

fn terminal_failure(
    failure: RunFailure,
    partial_text: String,
    partial_reasoning: String,
    usage: Option<Usage>,
) -> Box<ModelCycleFailure> {
    Box::new(ModelCycleFailure {
        failure,
        partial_text,
        partial_reasoning,
        usage,
        kind: FailureKind::Final,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::Usage,
        protocol::{FinishReason, ModelEvent, Refusal},
    };
    use tokio_stream::wrappers::ReceiverStream;

    #[tokio::test]
    async fn stop_discards_buffered_provider_events() {
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "stopped".into(),
            }),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta("must not be delivered".into())),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::Done(FinishReason::Stop)),
        ]));
        let (sender, mut receiver) = mpsc::channel(8);
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let failure = consume_model_cycle(stream, &sender, &cancellation, false)
            .await
            .unwrap_err();

        assert!(matches!(failure.failure, RunFailure::Client(_)));
        assert_eq!(failure.kind, FailureKind::Final);
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn stop_interrupts_a_full_output_queue_without_waiting_for_the_client() {
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "stopped".into(),
            }),
            Ok(ModelEvent::ThinkingStart),
            Ok(ModelEvent::ThinkingDelta("buffered reasoning".into())),
        ]));
        let (sender, mut receiver) = mpsc::channel(1);
        let cancellation = CancellationToken::new();
        let cycle = consume_model_cycle(stream, &sender, &cancellation, false);
        tokio::pin!(cycle);
        assert!(futures_util::poll!(&mut cycle).is_pending());
        assert_eq!(receiver.len(), 1);
        cancellation.cancel();

        let failure = tokio::time::timeout(std::time::Duration::from_secs(1), cycle)
            .await
            .expect("Stop blocked behind buffered output")
            .unwrap_err();

        assert!(matches!(failure.failure, RunFailure::Client(_)));
        assert_eq!(failure.kind, FailureKind::Final);
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::ThinkingStart)));
        assert!(
            receiver.try_recv().is_err(),
            "reasoning continued after Stop"
        );
    }

    #[tokio::test]
    async fn a_refusal_fails_the_call_and_keeps_the_text_already_sent() {
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "refused".into(),
            }),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta("Here is".into())),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::Done(FinishReason::Refusal(Refusal {
                category: Some("cyber".into()),
                explanation: Some("Cyber safeguards flagged the message.".into()),
            }))),
        ]));
        let (sender, mut receiver) = mpsc::channel(8);

        let failure = consume_model_cycle(stream, &sender, &CancellationToken::new(), false)
            .await
            .unwrap_err();

        assert_eq!(failure.kind, FailureKind::Refusal);
        assert_eq!(
            failure.failure,
            RunFailure::Refusal(
                "refused the request (cyber): Cyber safeguards flagged the message.".into()
            )
        );
        assert_eq!(failure.partial_text, "Here is");
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextStart)));
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextDelta(_))));
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextEnd)));
    }

    fn reply(text: &str, finish: FinishReason) -> ProtocolStream {
        Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "reply".into(),
            }),
            Ok(ModelEvent::ThinkingStart),
            Ok(ModelEvent::ThinkingDelta("thinking".into())),
            Ok(ModelEvent::ThinkingEnd),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta(text.into())),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::Done(finish)),
        ]))
    }

    #[tokio::test]
    async fn long_quoted_and_code_examples_are_delivered_without_fallback() {
        let text = format!(
            "{}\n\n````text\n```\nI cannot help with that.\n```\n````\n\n> Quoted response:\nI cannot assist with that.\n\nQuoted: \"`example` I won't help with that.\"\n\nHere is the working solution.",
            "The implementation follows these steps. ".repeat(100)
        );
        let mut events = vec![
            Ok(ModelEvent::Start {
                model_call_id: "quoted-examples".into(),
            }),
            Ok(ModelEvent::TextStart),
        ];
        events.extend(
            text.split_inclusive('\n')
                .map(|line| Ok(ModelEvent::TextDelta(line.into()))),
        );
        events.push(Ok(ModelEvent::TextEnd));
        events.push(Ok(ModelEvent::Done(FinishReason::Stop)));
        let stream = Box::pin(tokio_stream::iter(events));
        let (sender, mut receiver) = mpsc::channel(4);
        let consume = async move {
            let result =
                consume_model_cycle(stream, &sender, &CancellationToken::new(), true).await;
            drop(sender);
            result
        };
        let collect = async move {
            let mut delivered = String::new();
            while let Some(event) = receiver.recv().await {
                if let RunEvent::TextDelta(delta) = event {
                    delivered.push_str(&delta);
                }
            }
            delivered
        };
        let (result, delivered) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(consume, collect)
        })
        .await
        .expect("buffered delivery must respect channel backpressure");
        assert_eq!(result.unwrap().text, text);
        assert_eq!(delivered, text);
    }

    #[tokio::test]
    async fn a_refusal_after_long_text_and_a_thinking_gap_is_not_shown() {
        let introduction = "Some background about the request. ".repeat(100);
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "late-refusal".into(),
            }),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta(introduction)),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::ThinkingStart),
            Ok(ModelEvent::ThinkingDelta(
                "Considering the next step.".into(),
            )),
            Ok(ModelEvent::ThinkingEnd),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta("\n\nI won't be able to ".into())),
            Ok(ModelEvent::TextDelta("help with this request.".into())),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::Done(FinishReason::Stop)),
        ]));
        let (sender, mut receiver) = mpsc::channel(32);
        let failure = consume_model_cycle(stream, &sender, &CancellationToken::new(), true)
            .await
            .expect_err("a refusal anywhere in the response must trigger fallback");
        assert_eq!(failure.kind, FailureKind::Refusal);
        while let Ok(event) = receiver.try_recv() {
            assert!(!matches!(
                event,
                RunEvent::TextStart | RunEvent::TextDelta(_) | RunEvent::TextEnd
            ));
        }
    }

    #[tokio::test]
    async fn the_reported_refusal_is_detected_across_stream_chunks() {
        let (sender, mut receiver) = mpsc::channel(16);
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "reported-refusal".into(),
            }),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta("I won't be able to ".into())),
            Ok(ModelEvent::TextDelta("help debug this one. ".into())),
            Ok(ModelEvent::TextDelta(
                "I'm glad to help with things outside that scope.".into(),
            )),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::Done(FinishReason::Stop)),
        ]));

        let failure = consume_model_cycle(stream, &sender, &CancellationToken::new(), true)
            .await
            .expect_err("a plain-text refusal must trigger the refusal model");
        assert_eq!(failure.kind, FailureKind::Refusal);
        while let Ok(event) = receiver.try_recv() {
            assert!(!matches!(
                event,
                RunEvent::TextStart | RunEvent::TextDelta(_) | RunEvent::TextEnd
            ));
        }
    }

    #[tokio::test]
    async fn a_watched_reply_that_refuses_fails_as_a_refusal_without_being_shown() {
        let (sender, mut receiver) = mpsc::channel(16);

        let failure = consume_model_cycle(
            reply("I can't help build an aimbot.", FinishReason::Stop),
            &sender,
            &CancellationToken::new(),
            true,
        )
        .await
        .unwrap_err();

        assert_eq!(failure.kind, FailureKind::Refusal);
        while let Ok(event) = receiver.try_recv() {
            assert!(
                !matches!(
                    event,
                    RunEvent::TextStart | RunEvent::TextDelta(_) | RunEvent::TextEnd
                ),
                "refusal text reached the client"
            );
        }
    }

    #[tokio::test]
    async fn a_watched_ordinary_reply_is_delivered() {
        let (sender, mut receiver) = mpsc::channel(16);

        let result = consume_model_cycle(
            reply("Here is the fix.", FinishReason::Stop),
            &sender,
            &CancellationToken::new(),
            true,
        )
        .await
        .unwrap();

        assert_eq!(result.text, "Here is the fix.");
        let mut delivered = String::new();
        while let Ok(event) = receiver.try_recv() {
            if let RunEvent::TextDelta(delta) = event {
                delivered.push_str(&delta);
            }
        }
        assert_eq!(delivered, "Here is the fix.");
    }

    #[tokio::test]
    async fn refusal_wording_before_a_tool_call_is_delivered() {
        let stream = Box::pin(tokio_stream::iter(vec![
            Ok(ModelEvent::Start {
                model_call_id: "reply".into(),
            }),
            Ok(ModelEvent::TextStart),
            Ok(ModelEvent::TextDelta(
                "I can't help with that part, so:".into(),
            )),
            Ok(ModelEvent::TextEnd),
            Ok(ModelEvent::ToolCallStart {
                index: 0,
                call_id: "tool-call".into(),
                name: "read_file".into(),
            }),
            Ok(ModelEvent::ToolCallEnd { index: 0 }),
            Ok(ModelEvent::Done(FinishReason::ToolUse)),
        ]));
        let (sender, mut receiver) = mpsc::channel(16);

        let result = consume_model_cycle(stream, &sender, &CancellationToken::new(), true)
            .await
            .unwrap();

        assert_eq!(result.calls.len(), 1);
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextStart)));
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextDelta(_))));
        assert!(matches!(receiver.try_recv(), Ok(RunEvent::TextEnd)));
        assert!(matches!(
            receiver.try_recv(),
            Ok(RunEvent::ToolCallStart { .. })
        ));
    }

    #[tokio::test]
    async fn provider_tool_names_are_normalized_when_received() {
        let events = vec![
            Ok(ModelEvent::Start {
                model_call_id: "call".into(),
            }),
            Ok(ModelEvent::ToolCallStart {
                index: 0,
                call_id: "tool-call".into(),
                name: "multi_tool_use.parallel".into(),
            }),
            Ok(ModelEvent::ToolCallEnd { index: 0 }),
            Ok(ModelEvent::Done(FinishReason::ToolUse)),
        ];
        let stream = Box::pin(tokio_stream::iter(events));
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(4);

        let result = consume_model_cycle(stream, &event_tx, &CancellationToken::new(), false)
            .await
            .unwrap();

        assert_eq!(result.calls[0].name, "multi_tool_use_parallel");
        assert!(matches!(
            event_rx.recv().await,
            Some(RunEvent::ToolCallStart { name, .. }) if name == "multi_tool_use_parallel"
        ));
    }

    #[tokio::test]
    async fn usage_is_forwarded_before_the_provider_call_finishes() {
        let (provider_tx, provider_rx) = tokio::sync::mpsc::channel(4);
        let stream = Box::pin(ReceiverStream::new(provider_rx));
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(4);
        let cancellation = CancellationToken::new();
        let cycle_cancellation = cancellation.clone();
        let cycle = tokio::spawn(async move {
            consume_model_cycle(stream, &event_tx, &cycle_cancellation, false).await
        });
        let usage = Usage {
            input_tokens: Some(100),
            context_input_tokens: Some(100),
            output_tokens: Some(20),
            total_tokens: Some(120),
            ..Default::default()
        };

        provider_tx
            .send(Ok(ModelEvent::Start {
                model_call_id: "call".into(),
            }))
            .await
            .unwrap();
        provider_tx
            .send(Ok(ModelEvent::Usage(usage)))
            .await
            .unwrap();

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event, RunEvent::Usage(value) if value == usage));
        assert!(!cycle.is_finished(), "usage must arrive before Done");

        provider_tx
            .send(Ok(ModelEvent::Done(FinishReason::Stop)))
            .await
            .unwrap();
        drop(provider_tx);
        let result = cycle.await.unwrap().unwrap();
        assert_eq!(result.usage, Some(usage));
        assert!(event_rx.try_recv().is_err(), "usage must be forwarded once");
    }

    #[test]
    fn other_provider_errors_are_temporary() {
        let result = failure(
            RunFailure::Provider("Anthropic 502 Bad Gateway".into()),
            String::new(),
            String::new(),
            None,
        );
        assert_eq!(result.kind, FailureKind::Temporary);
        let timeout = failure(
            RunFailure::Provider("Anthropic 408 Request Timeout".into()),
            String::new(),
            String::new(),
            None,
        );
        assert_eq!(timeout.kind, FailureKind::Temporary);
    }

    #[test]
    fn rate_limits_are_rejections() {
        for message in [
            "Claude HTTP 429: This request would exceed your account's rate limit. Please try again later.",
            "OpenAI Chat 429 Too Many Requests: rate limit exceeded",
            "Devin resource_exhausted: account rate limit exceeded",
        ] {
            let result = failure(
                RunFailure::Provider(message.into()),
                String::new(),
                String::new(),
                None,
            );
            assert_eq!(result.kind, FailureKind::Rejected, "{message}");
        }
        assert!(!is_rejected_request(
            "Anthropic 502 Bad Gateway: upstream returned 429"
        ));
    }

    #[test]
    fn rejected_requests_are_rejections() {
        // Verbatim from a wedged conversation: eight retries of the same
        // over-limit prompt only delayed the error by forty seconds.
        let too_long = failure(
            RunFailure::Provider(
                "Anthropic 400 Bad Request: {\"type\":\"error\",\"error\":{\"type\":\
                 \"invalid_request_error\",\"message\":\"prompt is too long: 1002148 \
                 tokens > 1000000 maximum\"}}"
                    .into(),
            ),
            String::new(),
            String::new(),
            None,
        );
        assert_eq!(too_long.kind, FailureKind::Rejected);
        let unauthorized = failure(
            RunFailure::Provider("OpenAI Chat 401 Unauthorized: invalid api key".into()),
            String::new(),
            String::new(),
            None,
        );
        assert_eq!(unauthorized.kind, FailureKind::Rejected);
        // A status-looking number inside the body is not a status code.
        let body_number = failure(
            RunFailure::Provider("Anthropic 502 Bad Gateway: upstream returned 400".into()),
            String::new(),
            String::new(),
            None,
        );
        assert_eq!(body_number.kind, FailureKind::Temporary);
    }

    #[test]
    fn connect_rejections_and_rate_limits_never_retry_while_transport_errors_can() {
        for code in [
            "permission_denied",
            "unauthenticated",
            "invalid_argument",
            "not_found",
            "failed_precondition",
            "out_of_range",
            "unimplemented",
            "resource_exhausted",
        ] {
            assert!(
                is_rejected_request(&format!("Devin {code}: rejected request")),
                "{code}"
            );
        }
        for code in ["unavailable", "deadline_exceeded", "internal", "unknown"] {
            assert!(
                !is_rejected_request(&format!("Devin {code}: rejected request")),
                "{code}"
            );
        }
        assert!(!is_rejected_request(
            "Devin unavailable: upstream mentioned permission_denied"
        ));
    }
}
