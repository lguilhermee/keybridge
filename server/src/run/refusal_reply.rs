//! Catches a model that refuses in its own words.
//!
//! Some refusals arrive as an ordinary answer (finish reason `end_turn`), so
//! only the text shows them. For a model with a refusal model configured, the
//! entire reply text is held back until the call finishes. This lets a refusal
//! anywhere in the final answer switch models without showing the refused text.
//! Thinking still streams; tool calls release the text for the tool round.

mod detection;

use detection::is_refusal;

use super::RunEvent;

/// Text events held back from the client while the reply may be a refusal.
#[derive(Debug)]
pub(super) struct ReplyHold {
    held: Option<Vec<RunEvent>>,
}

impl ReplyHold {
    /// Holds text only when `watched`; otherwise every event passes through.
    pub(super) fn new(watched: bool) -> Self {
        Self {
            held: watched.then(Vec::new),
        }
    }

    /// Hold all text events until the whole answer can be checked.
    pub(super) fn text(&mut self, event: RunEvent) -> Vec<RunEvent> {
        let Some(held) = &mut self.held else {
            return vec![event];
        };
        held.push(event);
        Vec::new()
    }

    /// Stops holding; returns the events held so far, in order.
    pub(super) fn release(&mut self) -> Vec<RunEvent> {
        self.held.take().unwrap_or_default()
    }

    /// Inspect the completed answer once, including all its text blocks.
    pub(super) fn is_refusing(&self, text: &str) -> bool {
        self.held.is_some() && is_refusal(text)
    }

    /// The client has not seen the text block that is open.
    pub(super) fn has_held_text(&self) -> bool {
        self.held.as_ref().is_some_and(|held| !held.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwatched_replies_pass_straight_through() {
        let mut hold = ReplyHold::new(false);
        assert_eq!(hold.text(RunEvent::TextStart).len(), 1);
        assert!(!hold.is_refusing("I cannot help with that."));
    }

    #[test]
    fn a_refusing_reply_stays_held() {
        let mut hold = ReplyHold::new(true);
        assert!(hold.text(RunEvent::TextStart).is_empty());
        let text = "I can't help with that.";
        assert!(hold.text(RunEvent::TextDelta(text.into())).is_empty());
        assert!(hold.text(RunEvent::TextEnd).is_empty());
        assert!(hold.is_refusing(text));
    }

    #[test]
    fn an_ordinary_reply_stays_held_until_the_call_releases_it() {
        let mut hold = ReplyHold::new(true);
        assert!(hold.text(RunEvent::TextStart).is_empty());
        let text = "Helpful background. ".repeat(1_000);
        assert!(hold.text(RunEvent::TextDelta(text.clone())).is_empty());
        assert!(hold.text(RunEvent::TextEnd).is_empty());
        assert!(!hold.is_refusing(&text));
        assert_eq!(hold.release().len(), 3);
        assert!(hold.release().is_empty());
    }
}
