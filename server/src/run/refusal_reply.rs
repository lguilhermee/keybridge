//! Catches a model that refuses in its own words.
//!
//! Some refusals arrive as an ordinary answer (finish reason `end_turn`), so
//! only the text shows them. For a model with a refusal model configured, the
//! opening of the reply is held back from the client until it is known whether
//! it refuses: a refusing reply is never shown, any other reply is released and
//! streams on as usual.

use std::sync::OnceLock;

use regex::Regex;

use super::RunEvent;

/// Characters of the reply read before deciding whether it refuses.
const OPENING_CHARS: usize = 240;

/// Text events held back from the client while the reply may be a refusal.
#[derive(Debug)]
pub(super) struct ReplyHold {
    held: Option<Vec<RunEvent>>,
    refusing: bool,
}

impl ReplyHold {
    /// Holds text only when `watched`; otherwise every event passes through.
    pub(super) fn new(watched: bool) -> Self {
        Self {
            held: watched.then(Vec::new),
            refusing: false,
        }
    }

    /// Text event to send now; `text` is the reply so far, including it.
    pub(super) fn text(&mut self, event: RunEvent, text: &str) -> Vec<RunEvent> {
        let Some(held) = &mut self.held else {
            return vec![event];
        };
        let ended = matches!(event, RunEvent::TextEnd);
        held.push(event);
        if self.refusing || !(ended || text.chars().nth(OPENING_CHARS).is_some()) {
            return Vec::new();
        }
        if is_refusal(text) {
            self.refusing = true;
            Vec::new()
        } else {
            self.release()
        }
    }

    /// Thinking that follows held text means the reply goes on; before any
    /// text, thinking passes through and the hold stays.
    pub(super) fn thinking(&mut self) -> Vec<RunEvent> {
        if self.has_held_text() {
            self.release()
        } else {
            Vec::new()
        }
    }

    /// Stops holding; returns the events held so far, in order.
    pub(super) fn release(&mut self) -> Vec<RunEvent> {
        self.held.take().unwrap_or_default()
    }

    /// The reply opened with a refusal and nothing has been shown of it.
    pub(super) fn is_refusing(&self) -> bool {
        self.refusing && self.held.is_some()
    }

    /// The client has not seen the text block that is open.
    pub(super) fn has_held_text(&self) -> bool {
        self.held.as_ref().is_some_and(|held| !held.is_empty())
    }
}

/// Whether the opening of `text` refuses the request.
fn is_refusal(text: &str) -> bool {
    static REFUSAL: OnceLock<Regex> = OnceLock::new();
    let refusal = REFUSAL.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)",
            // English: "I can't help", "I'm not able to build", "I won't write"...
            r"\bi(?:\s+(?:can't|cannot|can\s+not|won't|will\s+not)|(?:'m|\s+am)\s+(?:not\s+able|unable|not\s+going)\s+to)",
            r"\s+(?:\w+\s+)?(?:help|assist|build|create|write|provide|make|develop|implement|support|contribute|generate|produce|work\s+on)\b",
            r"|\bi(?:'m|\s+am)\s+not\s+comfortable\s+(?:helping|building|creating|writing|providing)\b",
            r"|\b(?:must|need\s+to|have\s+to|going\s+to|'ll)\s+(?:respectfully\s+)?decline\b",
            // Portuguese: "Não posso ajudar", "não vou criar"...
            r"|\bnão\s+(?:posso|consigo|vou|poderei|irei)\s+(?:\w+\s+)?",
            r"(?:ajudar|auxiliar|criar|fornecer|escrever|construir|desenvolver|fazer|implementar|colaborar|gerar|produzir)\b",
            r"|\b(?:preciso|devo|vou|tenho\s+que)\s+recusar\b",
            // Chinese: "我不能帮助", "我无法提供"...
            r"|我(?:不能|无法|不会|没法|没办法|不可以).{0,4}?(?:帮|协助|提供|编写|创建|开发|制作|实现)",
        ))
        .expect("valid refusal expression")
    });
    let opening = text
        .trim_start()
        .chars()
        .take(OPENING_CHARS)
        .map(|character| {
            if character == '\u{2019}' {
                '\''
            } else {
                character
            }
        })
        .collect::<String>();
    refusal.is_match(&opening)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_in_the_opening_are_recognised() {
        for text in [
            "I can't help build an aimbot for this project. Delta Force is an online shooter.",
            "I can\u{2019}t help with that.",
            "Sorry, but I cannot assist with this request.",
            "I'm not able to write that code.",
            "I won't really help create malware.",
            "I need to decline this one.",
            "I'm not comfortable building that.",
            "Não posso ajudar a criar um aimbot para este jogo.",
            "Infelizmente não vou criar isso.",
            "抱歉，我不能帮助你制作外挂。",
            "我无法提供这类代码。",
        ] {
            assert!(is_refusal(text), "{text}");
        }
    }

    #[test]
    fn ordinary_replies_are_not_refusals() {
        for text in [
            "I updated the parser and the tests pass.",
            "Here is how to build the project:",
            "I can't reproduce the crash locally; here is what I checked.",
            "The helper can't create the directory when it is read-only.",
            "Não consegui reproduzir o erro.",
        ] {
            assert!(!is_refusal(text), "{text}");
        }
        let late = format!("{} I can't help with that.", "word ".repeat(60));
        assert!(!is_refusal(&late));
    }

    #[test]
    fn unwatched_replies_pass_straight_through() {
        let mut hold = ReplyHold::new(false);
        assert_eq!(hold.text(RunEvent::TextStart, "").len(), 1);
        assert!(!hold.is_refusing());
    }

    #[test]
    fn a_refusing_reply_stays_held() {
        let mut hold = ReplyHold::new(true);
        assert!(hold.thinking().is_empty());
        assert!(hold.text(RunEvent::TextStart, "").is_empty());
        let text = "I can't help with that.";
        assert!(hold.text(RunEvent::TextDelta(text.into()), text).is_empty());
        assert!(hold.text(RunEvent::TextEnd, text).is_empty());
        assert!(hold.is_refusing());
    }

    #[test]
    fn an_ordinary_reply_is_released_once_its_opening_is_read() {
        let mut hold = ReplyHold::new(true);
        assert!(hold.text(RunEvent::TextStart, "").is_empty());
        let opening = "a".repeat(OPENING_CHARS + 1);
        let released = hold.text(RunEvent::TextDelta(opening.clone()), &opening);
        assert_eq!(released.len(), 2);
        assert!(!hold.is_refusing());
        let more = format!("{opening}b");
        assert_eq!(hold.text(RunEvent::TextDelta("b".into()), &more).len(), 1);
    }
}
