//! Defines normalized protocol streaming events.
use crate::model::{ProtocolReplayState, Usage};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    Length,
    ToolUse,
    Refusal(Refusal),
}

/// A model's explicit signal that it declines to answer on policy grounds.
/// Only what the upstream API states is carried; answer text is never inspected.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Refusal {
    /// The upstream's policy label, such as `cyber`.
    pub category: Option<String>,
    pub explanation: Option<String>,
}

impl Refusal {
    pub fn new(category: Option<&str>, explanation: Option<&str>) -> Self {
        let clean = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            category: clean(category),
            explanation: clean(explanation),
        }
    }
}

/// Reads as the predicate of a sentence whose subject is the model's name.
impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("refused the request")?;
        if let Some(category) = &self.category {
            write!(formatter, " ({category})")?;
        }
        if let Some(explanation) = &self.explanation {
            write!(formatter, ": {explanation}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    Start {
        model_call_id: String,
    },
    TextStart,
    TextDelta(String),
    TextEnd,
    ThinkingStart,
    ThinkingDelta(String),
    ThinkingEnd,
    ToolCallStart {
        index: usize,
        call_id: String,
        name: String,
    },
    ToolCallArgumentsDelta {
        index: usize,
        delta: String,
    },
    ToolCallEnd {
        index: usize,
    },
    ProtocolReplayState(ProtocolReplayState),
    Usage(Usage),
    Done(FinishReason),
}

/// Returns whether an event represents the first valid upstream response.
/// Transport markers, replay metadata, usage, completion, and provider heartbeats
/// are intentionally excluded; empty text/reasoning/tool deltas are valid events.
pub fn is_valid_response_event(event: &ModelEvent) -> bool {
    matches!(
        event,
        ModelEvent::TextDelta(_)
            | ModelEvent::ThinkingStart
            | ModelEvent::ThinkingDelta(_)
            | ModelEvent::ThinkingEnd
            | ModelEvent::ToolCallStart { .. }
            | ModelEvent::ToolCallArgumentsDelta { .. }
            | ModelEvent::ToolCallEnd { .. }
    )
}
