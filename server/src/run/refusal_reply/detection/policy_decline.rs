//! Links operational declines to their policy reason in owned prose.
use std::sync::OnceLock;

use regex::Regex;

const ACTION: &str = r"(?:operate|run|launch|start|execute|use|test|continue|proceed|click)";
const CONTROL: &str =
    r"(?:anti[- ]cheat|VM[- ](?:detection|checks?)|security\s+(?:controls?|protections?|checks?))";

/// Paragraph/code/quotation boundaries come from the Markdown ownership filter.
pub(super) fn is_refusal(text: &str) -> bool {
    for paragraph in text.split(['\u{1}', '\0']) {
        let reasons: Vec<_> = reason().find_iter(paragraph).collect();
        let mut sentence_offset = 0;
        for sentence in paragraph.split_inclusive(['.', '!', '?']) {
            if !operational_limit().is_match(sentence) {
                for decline in decline().captures_iter(sentence) {
                    let matched = decline.get(0).expect("complete decline match");
                    let tail = &sentence[matched.end()..];
                    let direct = decline.name("direct").is_some();

                    // A stated operational cause must not inherit a policy reason
                    // from elsewhere: "can't run that path because it crashed".
                    if let Some(cause) = cause().find(tail) {
                        if reason().is_match(&tail[cause.end()..]) {
                            return true;
                        }
                        continue;
                    }
                    if direct && bypass_object().is_match(tail) {
                        return true;
                    }

                    let position = sentence_offset + matched.start();
                    let Some(prior) = reasons.iter().rev().find(|reason| reason.end() <= position)
                    else {
                        continue;
                    };
                    let between = &paragraph[prior.end()..position];
                    if operational_limit().is_match(&paragraph[prior.start()..position]) {
                        continue;
                    }
                    // "The route uses a replacement, so I stopped before using it."
                    // "That path" may refer to the preceding sentence, but never
                    // to a reason in another paragraph or an omitted quotation.
                    if consequence().is_match(between)
                        || (direct && referenced_path().is_match(tail))
                    {
                        return true;
                    }
                }
            }
            sentence_offset += sentence.len();
        }
    }
    false
}

fn decline() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(&format!(concat!(
        r"(?i)\b(?:(?P<direct>",
        r"(?:i|we)(?:\s+(?:can't|cannot|can\s+not|won't|will\s+not)|(?:'m|'re|\s+am|\s+are)\s+(?:not\s+going|unable|unwilling)\s+to)\s+{action}",
        r"|(?:i|we)\s+can\s+[^.!?]{{0,240}}\bbut\s+(?:(?:i|we)\s+)?(?:not|can't|cannot|won't|will\s+not)\s+{action})",
        r"|(?:i|we)\s+(?:(?:did\s+not|didn't|have\s+not|haven't)\s+(?:start(?:ed)?|launch(?:ed)?|run|use(?:d)?|execut(?:e|ed)|continu(?:e|ed)|proceed(?:ed)?|click(?:ed)?)",
        r"|(?:stopped|paused|halted)\s+(?:before|prior\s+to|short\s+of|without)\s+(?:starting|launching|running|using|operating|executing|continuing|proceeding)))\b"
    ), action = ACTION)).expect("valid policy decline expression"))
}

fn reason() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(&format!(concat!(
        r"(?i)\b(?:(?:uses?|requires?|(?:rel(?:y|ies)|depends?)\s+on|involves?)\s+(?:(?:an?|the)\s+)?{control}\s+(?:replacements?|bypass(?:es)?)",
        r"|(?:bypass(?:es|ing)?|evad(?:e|es|ing)|replac(?:e|es|ing)|disabl(?:e|es|ing))\s+(?:[a-z'-]+\s+){{0,4}}{control})\b"
    ), control = CONTROL)).expect("valid policy reason expression"))
}

fn bypass_object() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(&format!(
        r"(?i)^\s+(?:(?:this|that|the|an?|these|those|its|your)\s+)?(?:bypass(?:es|-backed)?|{control}\s+(?:replacements?|bypass(?:es)?))(?:\s|[.,;:!?]|$)",
        control = CONTROL,
    )).expect("valid declined object expression"))
}

fn referenced_path() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(
            r"(?i)^\s+(?:it|(?:this|that)\s+(?:path|route|setup|configuration|launch|run))\b",
        )
        .expect("valid path reference expression")
    })
}

fn cause() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:because|due\s+to|since|until|while|without)\b")
            .expect("valid cause expression")
    })
}

fn consequence() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:so|therefore|thus|which\s+is\s+why|that's\s+why)\b")
            .expect("valid consequence expression")
    })
}

fn operational_limit() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new(concat!(
        r"(?i)\b(?:crash(?:ed|es)?|missing|unavailable|not\s+installed|not\s+connected|permission\s+denied|timed?\s+out|",
        r"no\s+(?:host\s+)?access|(?:don't|do\s+not)\s+have\s+(?:host\s+)?access|no\s+display|from\s+(?:here|this\s+session))\b"
    )).expect("valid operational limit expression"))
}

#[cfg(test)]
mod tests {
    use super::is_refusal;

    #[test]
    fn operational_objects_and_references_require_a_policy_decline() {
        for text in [
            "I can't operate that bypass to run the protected client.",
            "I can help debug the renderer, but not run that bypass against the authenticated game.",
            "The route relies on an anti-cheat replacement. I can analyze the evidence, but I can't operate that path.",
            "The route depends on an anti-cheat replacement, so I stopped before using it.",
            "I stopped before launching because the route relies on an anti-cheat replacement and a modified guest environment.",
        ] {
            assert!(is_refusal(text), "{text}");
        }
        for text in [
            "I can't operate that path.",
            "I can't operate that bypass because it crashed.",
            "I can't run that bypass until the host is connected.",
            "I can't run that bypass from here.",
            "I can't run a bypass-free example.",
            "I did not run the bypass. The normal launch worked.",
            "The route uses an anti-cheat replacement. I can't operate that path because the file is locked.",
            "The route relies on an anti-cheat replacement.\u{1}I can't operate that path.",
            "The route relies on\0 an anti-cheat replacement. I can't operate that path.",
            "The route uses an anti-cheat replacement that crashed, so I stopped before using it.",
            "I saved the traces and found no demonstrated rendering defect to patch.",
        ] {
            assert!(!is_refusal(text), "{text}");
        }
    }
}
