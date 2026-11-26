//! Catches a model that refuses in its own words.
//!
//! Some refusals arrive as an ordinary answer, so only the text shows them. For
//! a model with a refusal model configured, the entire reply text is held back
//! until the call finishes. This lets a refusal anywhere in the final answer
//! switch models without showing the refused text. Thinking still streams; a
//! tool call flushes the text so the tool round can start, but the watch stays
//! armed because the notice and its tool calls arrive in the same answer.

mod detection;

pub(crate) use detection::is_refusal;

use super::RunEvent;

/// Watches a reply for a refusal and keeps its text away from the client
/// until the answer is judged.
#[derive(Debug)]
pub(super) struct ReplyHold {
    /// `Some` while the answer may still turn out to be a refusal. The buffer
    /// is the text not yet handed to the client; it is separate from the watch
    /// so a flush does not end it.
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

    /// Hands the text held so far to the client, in order, and keeps watching.
    pub(super) fn flush(&mut self) -> Vec<RunEvent> {
        self.held.as_mut().map(std::mem::take).unwrap_or_default()
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
    fn an_ordinary_reply_stays_held_until_the_call_judges_it() {
        let mut hold = ReplyHold::new(true);
        assert!(hold.text(RunEvent::TextStart).is_empty());
        let text = "Helpful background. ".repeat(1_000);
        assert!(hold.text(RunEvent::TextDelta(text.clone())).is_empty());
        assert!(hold.text(RunEvent::TextEnd).is_empty());
        assert!(!hold.is_refusing(&text));
        assert!(hold.has_held_text());
        assert_eq!(hold.flush().len(), 3);
        assert!(hold.flush().is_empty());
        assert!(!hold.has_held_text());
    }

    #[test]
    fn a_notice_with_a_tool_call_stays_watched_after_the_flush() {
        let mut hold = ReplyHold::new(true);
        hold.text(RunEvent::TextStart);
        let notice = "I cannot continue developing anti-cheat bypass functionality.";
        hold.text(RunEvent::TextDelta(notice.into()));
        hold.text(RunEvent::TextEnd);
        assert!(hold.has_held_text());

        // The tool call hands the buffered text to the client but the answer
        // is still judged.
        assert_eq!(hold.flush().len(), 3);
        assert!(!hold.has_held_text());
        assert!(hold.is_refusing(notice));
        assert!(hold.flush().is_empty());
    }

    #[test]
    fn an_ordinary_reply_before_a_tool_call_is_still_not_a_refusal() {
        let mut hold = ReplyHold::new(true);
        hold.text(RunEvent::TextStart);
        let text = "Reading the parser module first.";
        hold.text(RunEvent::TextDelta(text.into()));
        hold.text(RunEvent::TextEnd);
        hold.flush();
        assert!(!hold.is_refusing(text));
    }
}
