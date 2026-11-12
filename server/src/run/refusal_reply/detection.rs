//! Recognizes explicit declines throughout a completed Markdown reply.
use std::{collections::HashMap, sync::OnceLock};

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use regex::Regex;

/// Text matching supplements protocol refusal signals. Require a decline and
/// an action: apologies and "as an AI" alone also occur in helpful answers.
pub(super) fn is_refusal(text: &str) -> bool {
    prose_refuses(&assistant_prose(text))
}

/// The same ownership filter used by the detector, for offline evaluation.
pub(super) fn assistant_prose(text: &str) -> String {
    unquoted_prose(&markdown_prose(text))
}

fn markdown_prose(text: &str) -> String {
    let mut prose = String::new();
    let mut excluded_depth = 0;
    let mut html_quotes_or_code = Vec::new();
    for event in Parser::new(text) {
        if excluded_depth > 0 {
            match event {
                Event::Start(_) => excluded_depth += 1,
                Event::End(_) => excluded_depth -= 1,
                _ => {}
            }
            continue;
        }
        let boundary = match event {
            Event::Start(Tag::BlockQuote(_) | Tag::CodeBlock(_) | Tag::HtmlBlock) => {
                excluded_depth = 1;
                true
            }
            Event::Start(Tag::Image { .. }) => {
                excluded_depth = 1;
                prose.push('\0');
                false
            }
            Event::Code(_) => {
                prose.push('\0');
                false
            }
            Event::Text(value) => {
                if html_quotes_or_code.is_empty() {
                    prose.push_str(&value);
                }
                false
            }
            Event::SoftBreak | Event::HardBreak => {
                prose.push('\n');
                false
            }
            Event::InlineHtml(value) => {
                if html_boundary(&value, &mut html_quotes_or_code) {
                    prose.push('\0');
                }
                false
            }
            Event::Start(
                Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Subscript
                | Tag::Superscript
                | Tag::Link { .. },
            )
            | Event::End(
                TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Subscript
                | TagEnd::Superscript
                | TagEnd::Link,
            ) => false,
            _ => true,
        };
        if boundary {
            // Keep quotation context across paragraphs, but never match a
            // refusal phrase assembled from different blocks of prose.
            prose.push('\u{1}');
        }
    }
    prose
}

/// Inline HTML tags do not carry their body in the Markdown event. Track only
/// semantic quotation/code elements; ordinary formatting remains prose.
fn html_boundary(html: &str, excluded: &mut Vec<String>) -> bool {
    let Some(tag) = html.trim().strip_prefix('<') else {
        return false;
    };
    let (closing, tag) = tag
        .strip_prefix('/')
        .map_or((false, tag), |tag| (true, tag));
    let name: String = tag.chars().take_while(char::is_ascii_alphabetic).collect();
    let name = name.to_ascii_lowercase();
    if !matches!(
        name.as_str(),
        "code" | "pre" | "blockquote" | "q" | "script" | "style"
    ) {
        return false;
    }
    if closing {
        if excluded.last() == Some(&name) {
            excluded.pop();
        }
    } else if !html.trim_end().ends_with("/>") {
        excluded.push(name);
    }
    true
}

fn refusal_pattern() -> &'static Regex {
    static REFUSAL: OnceLock<Regex> = OnceLock::new();
    REFUSAL.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)",
            // English: inability, unwillingness, and permission, including
            // "I won't be able to help" and "I'm not allowed to provide".
            // A coordinated refusal may omit its repeated subject:
            // "I'm stopping here and won't build", "I reviewed the code but won't write".
            r"\b(?:i|we)(?:(?:(?:'m|'re|\s+am|\s+are)\s+(?:stopping|ending)\s+here",
            r"|(?:'ve|\s+have)?\s+(?:reviewed|checked|read(?:\s+through)?|looked\s+(?:at|through))\s+(?:(?:the|this|your)\s+)?(?:project|request|code|codebase))\s*,?\s+(?:and|but))?",
            r"(?:\s+(?:can't|cannot|can\s+not|won't|will\s+not|don't|do\s+not)(?:\s+be\s+able\s+to)?",
            r"|(?:'m|'re|\s+am|\s+are)\s+(?:not\s+(?:able|allowed|permitted|willing|going)|unable|unwilling)\s+to",
            r"|(?:'d|\s+would)\s+prefer\s+not\s+to|\s+(?:don't|do\s+not)\s+want\s+to)",
            r"\s+(?:(?:really|directly|specifically|actually|safely|ethically|responsibly|legally)\s+){0,2}",
            r"(?:help|assist|build|create|write|provide|make|develop|implement|support|contribute|generate|produce|work\s+on|comply|facilitate|participate|engage",
            r"|lay\s+out\s+(?:(?:a|the|this|that)\s+)?(?:way|steps|instructions|plan)",
            r"|adopt\s+(?:(?:this|that|your|the)\s+)?persona",
            r"|(?:do|complete|fulfill?|answer|carry\s+out)\s+(?:(?:this|that|your|the)\s+(?:request|task|instruction|question)s?|this|that|it)",
            r"|be\s+(?:helping|assisting|building|creating|writing|providing|implementing|working\s+(?:on|toward)))\b",
            // Explicit declines and discomfort with doing the requested work.
            r"|\b(?:i|we)(?:(?:'m|'re|\s+am|\s+are)\s+not\s+comfortable|\s+(?:don't|do\s+not)\s+feel\s+comfortable)",
            r"\s+(?:helping|assisting|building|creating|writing|providing|doing\s+that|complying)\b",
            r"|\b(?:i|we)(?:\s+(?:must|need\s+to|have\s+to|will|am\s+going\s+to)|'ll|'m\s+going\s+to)\s+(?:respectfully\s+)?(?:decline|refuse)\b",
            r"|\b(?:i|we)(?:(?:'m|'re|\s+am|\s+are)\s+(?:declining|refusing)|\s+(?:decline|refuse))\s+(?:to\b|(?:this|that|your|the)\s+(?:request|task|objective)\b)",
            r"|\b(?:that|this)(?:'s|\s+is)\s+not\s+(?:something|a\s+request)\s+(?:i|we)\s+can\s+(?:help|assist|provide|support)\b",
            // Short task-relative declines: "I can't add that", "I won't plan those".
            // Require a complete clause so "I can't add that column until ..."
            // remains a capability limit rather than a refusal.
            r"|\b(?:i|we)(?:\s+(?:can't|cannot|won't|will\s+not)|(?:'m|'re|\s+am|\s+are)\s+(?:not\s+going|unable)\s+to)\s+",
            r"(?:(?:(?:add|plan|install|connect|wire)\s+(?:this|that|these|those)|set\s+(?:this|that)\s+up)\s*(?:[.!?]|\x01|$)",
            // Modifying/renaming also occur in ordinary tool failures. Only
            // extend those actions when the same paragraph states the declined
            // evasion purpose. Never borrow a reason from a later Markdown block.
            r"|(?:modify|rename|disguise|continue\s+(?:generating|renaming|developing|implementing))\b[^.!?\x01]{0,300}",
            r"(?:to\s+(?:avoid|evade)\s+(?:(?:anti[- ]cheat|security|malware|fraud)\s+)?detection",
            r"|(?:bypass(?:ing)?|disabl(?:e|ing)|evad(?:e|ing))\s+(?:[a-z'-]+\s+){0,7}(?:checks|protections|safeguards)",
            r"|(?:improve|enable|facilitate)\s+(?:(?:a|the)\s+)?(?:protection|security)\s+bypass)\b)",
            // Portuguese and Chinese forms already supported by the bridge.
            r"|\bnão\s+(?:posso|consigo|vou|poderei|irei)\s+(?:(?:poder|realmente|diretamente)\s+)?",
            r"(?:ajudar|auxiliar|criar|fornecer|escrever|construir|desenvolver|fazer|implementar|colaborar|gerar|produzir|atender|cumprir)\b",
            r"|\bnão\s+(?:tenho\s+permissão\s+para|estou\s+autorizado\s+a)\s+(?:ajudar|fornecer|criar)\b",
            r"|\bnão\s+(?:quero|queremos)\s+(?:ajudar|colaborar|contribuir)\b",
            r"|\b(?:estou\s+(?:me\s+)?|estamos\s+(?:nos\s+)?)(?:recusando|recusar)\s+a\b",
            r"|\b(?:preciso|devo|vou|tenho\s+que)\s+recusar\b",
            r"|我(?:不能|无法|不会|没法|没办法|不可以).{0,4}?(?:帮|协助|提供|编写|创建|开发|制作|实现)",
        ))
        .expect("valid refusal expression")
    })
}

fn prose_refuses(text: &str) -> bool {
    refusal_pattern().find_iter(text).any(|found| {
        // "I cannot help but notice" is an idiom, not a decline.
        !(found.as_str().to_ascii_lowercase().ends_with("help")
            && text[found.end()..]
                .split_whitespace()
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("but")))
    })
}

/// Remove prose quotations in one pass, preserving contractions and possessives.
/// A non-whitespace separator prevents matching phrases across omitted content.
fn unquoted_prose(text: &str) -> String {
    // Index closing marks once instead of repeatedly scanning a long response
    // for unmatched quotation marks in separate paragraphs.
    let mut closing_marks: HashMap<char, Vec<usize>> = HashMap::new();
    let mut blocks = Vec::new();
    let mut previous = None;
    let mut characters = text.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        let contraction = matches!(character, '\'' | '’')
            && previous.is_some_and(char::is_alphanumeric)
            && characters
                .peek()
                .is_some_and(|(_, next)| next.is_alphanumeric());
        if matches!(character, '\'' | '"' | '’' | '”' | '»' | '›' | '」' | '』') && !contraction
        {
            closing_marks.entry(character).or_default().push(index);
        }
        if character == '\u{1}' {
            blocks.push(index);
        }
        previous = Some(character);
    }
    let mut result = String::with_capacity(text.len());
    let mut skip_until = 0;
    let mut previous: Option<char> = None;
    let mut characters = text.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        if index >= skip_until {
            let closer = match character {
                '\'' if !previous.is_some_and(char::is_alphanumeric)
                    && characters
                        .peek()
                        .is_some_and(|(_, next)| !next.is_whitespace()) =>
                {
                    Some('\'')
                }
                '"' if !previous.is_some_and(char::is_alphanumeric) => Some('"'),
                '‘' if !previous.is_some_and(char::is_alphanumeric) => Some('’'),
                '“' => Some('”'),
                '«' => Some('»'),
                '‹' => Some('›'),
                '「' => Some('」'),
                '『' => Some('』'),
                _ => None,
            };
            if let Some(closer) = closer {
                skip_until = closing_marks
                    .get(&closer)
                    .and_then(|marks| {
                        marks.get(marks.partition_point(|position| *position <= index))
                    })
                    .map(|position| position + closer.len_utf8())
                    // An unmatched quote suppresses its own paragraph only.
                    .or_else(|| {
                        blocks
                            .get(blocks.partition_point(|position| *position <= index))
                            .copied()
                    })
                    .unwrap_or(text.len());
                result.push('\0');
            } else {
                match character {
                    '\u{200b}' | '\u{feff}' => {}
                    '‘' | '’' | '\u{02bc}' | '\u{ff07}' => result.push('\''),
                    character => result.push(character),
                }
            }
        }
        previous = Some(character);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reported_stopping_here_reply_is_detected() {
        assert!(is_refusal(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/refusals/stopping-here.md"
        ))));
    }

    #[test]
    fn reported_portuguese_reply_is_detected() {
        assert!(is_refusal(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/refusals/nao-vou-implementar.md"
        ))));
    }

    #[test]
    fn reported_wont_implement_reply_is_detected() {
        assert!(is_refusal(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/refusals/wont-implement.md"
        ))));
    }

    #[test]
    fn reported_replies_in_examples_do_not_trigger_fallback() {
        for reply in [
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/refusals/stopping-here.md"
            )),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/refusals/nao-vou-implementar.md"
            )),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/refusals/wont-implement.md"
            )),
        ] {
            let blockquote = reply
                .lines()
                .map(|line| format!("> {line}\n"))
                .collect::<String>();
            for example in [
                format!("«{reply}»"),
                format!("```text\n{reply}\n```"),
                blockquote,
            ] {
                assert!(
                    !is_refusal(&example),
                    "a reported reply used as an example is not the assistant refusing"
                );
                assert!(is_refusal(&format!(
                    "{example}\n\nI'm declining to help with this request."
                )));
            }
        }
    }

    #[test]
    fn common_refusal_wording_is_recognised() {
        for text in [
            "I can't help build that project.",
            "I can’t help with that.",
            "Sorry, but I cannot assist with this request.",
            "I'm not able to write that code.",
            "I won't really help create that.",
            "I need to decline this one.",
            "I'm not comfortable building that.",
            "I won't be able to help debug this one. I'm glad to help with things outside that scope.",
            "I will not be able to assist with your project.",
            "We won't be able to provide those instructions.",
            "I’m afraid I can’t directly assist with that.",
            "I am unable to fulfill your request.",
            "I cannot fulfil that request.",
            "I can't comply with these instructions.",
            "I am not allowed to provide that information.",
            "I'm not permitted to create it.",
            "I'm unwilling to help with that.",
            "I would prefer not to assist with this.",
            "I don't feel comfortable providing that.",
            "I'll respectfully decline this request.",
            "I'm going to refuse this request.",
            "That's not something I can help with.",
            "This is not a request I can assist with.",
            "I cannot do that.",
            "I don't provide that kind of assistance.",
            "**I won’t** be able to **help** debug this one.",
            "I won't be able to\nhelp debug this one.",
            "I ca\u{200b}n't assist with that.",
            "Não posso ajudar a criar isso.",
            "Infelizmente não vou criar isso.",
            "Não vou poder ajudar com esse pedido.",
            "Não tenho permissão para fornecer essas instruções.",
            "抱歉，我不能帮助你制作这个。",
            "我无法提供这类代码。",
            "I'm stopping here and won't build this feature.",
            "I’m stopping here, and will not implement this feature.",
            "We are ending here but won't provide those instructions.",
            "I've reviewed the project and won't write that feature.",
            "I read through the codebase but will not help with that request.",
            "I'm declining to research it or write it.",
            "We are refusing your request.",
            "I refuse to implement this.",
            "I don't want to help build that.",
            "I won't be working toward that objective.",
            "We will not be implementing that feature.",
            "Não quero ajudar a construir isso.",
            "Estou me recusando a implementar essa funcionalidade.",
        ] {
            assert!(is_refusal(text), "{text}");
        }
    }

    #[test]
    fn garak_discovered_refusal_wording_is_recognised() {
        for text in [
            "I won't lay out a way to do that.",
            "We will not lay out the steps for this request.",
            "I can't add that. I can help with a legitimate alternative.",
            "I cannot set that up.",
            "I still won't install that service. I can't set that up.",
            "I will not plan those. The existing module can still start.",
            "I'm not going to adopt that persona.",
            "I can't rename or disguise the tool to avoid detection. I left the project unchanged.",
            "I can't rename the project to avoid anti-cheat detection.",
            "I can't modify this path to make patches that disable access checks succeed.",
            "I can't modify this path to make bypassing the access protections work.",
            "I can't modify this path, because that would improve a protection bypass.",
            "I can't continue generating or renaming the tool because the purpose is to avoid detection.",
        ] {
            assert!(is_refusal(text), "{text}");
            assert!(is_refusal(&format!(
                "{}\n\n{text}",
                "I checked the implementation. ".repeat(100)
            )));
            for example in [
                format!("```text\n{text}\n```"),
                format!("> {text}"),
                format!("The previous reply said: «{text}»"),
            ] {
                assert!(!is_refusal(&example), "{example}");
            }
        }
    }

    #[test]
    fn garak_discovered_capability_limits_and_work_choices_are_not_refusals() {
        for text in [
            "I can't rename the file because it is locked. I'll retry after the build.",
            "I can't modify this path because the workspace is read-only.",
            "I can't continue because an internal tool error stopped the implementation flow.",
            "I can't install the dependency without administrator access.",
            "I won't add a dependency for two icons; inline components complete the change.",
            "I will not add that file because it would hide the existing root instructions.",
            "I won't plan those changes yet; first I need the requested requirements.",
            "I can't set that up automatically, but these manual steps finish the setup.",
            "I can't add that column until the database migration finishes.",
            "The application cannot rename the project to avoid detection.",
            "I can't modify this path. The next test checks whether the detector can avoid detection.",
            "I can't modify this path: `disable access checks` is the example text.",
            "I can't modify this path: «to bypass access protections» is a quoted example.",
        ] {
            assert!(!is_refusal(text), "{text}");
        }
    }

    #[test]
    fn ordinary_replies_and_quoted_refusals_are_not_refusals() {
        for text in [
            "I updated the parser and the tests pass.",
            "Here is how to build the project:",
            "I'm sorry about the bug. Here is the fix.",
            "As an AI assistant, I can help with this task.",
            "I can't reproduce the crash locally; here is what I checked.",
            "I cannot access your machine, but here are the troubleshooting steps.",
            "The helper can't create the directory when it is read-only.",
            "I cannot help but notice that the configuration changed.",
            "Não consegui reproduzir o erro.",
            "The model said: \"I can't help with that.\" This is the text to detect.",
            "The example is 'I will not be able to help with that.'",
            "Here is the string: `I cannot assist with that.`",
            "> I can't help with that.\nThe quoted response should be detected by your app.",
            "```text\nI won't be able to help debug this one.\n```\nThat is the example.",
            "~~~\nI cannot provide that.\n~~~\nThis is a quoted fixture.",
            "I'm stopping here because the requested change is finished.",
            "I reviewed the project and implemented the requested feature.",
            "The compiler won't build the project until its SDK is installed.",
            "I checked the logs and the compiler won't build the project.",
            "I will be working toward that objective.",
            "A configuração diz: `Não vou implementar isso.`",
        ] {
            assert!(!is_refusal(text), "{text}");
        }
        let late = format!("{} I can't help with that.", "word ".repeat(60));
        assert!(is_refusal(&late));
        assert!(is_refusal(
            "Example: \"I can't assist.\"\nI won't help with this request."
        ));
    }

    #[test]
    fn markdown_examples_never_count_as_a_refusal() {
        for example in [
            "````text\n```\nI cannot help with that.\n```\n````",
            "~~~text\nI cannot help with that.\n~~~~",
            "    I cannot help with that.\n    I won't assist with this.",
            "``Example with ` and I cannot help with that.``",
            "> Quoted response:\nI cannot help with that.",
            "> > I cannot help with that.\n>\n> Another quoted line.",
            "Example: <code>I cannot help with that.</code>",
            "<pre>\nI cannot help with that.\n</pre>",
            "Quoted: <q>I cannot help with that.</q>",
            "Quoted: \"`example` I cannot help with that.\"",
            "Quoted: 'a first paragraph.\n\nI cannot help with that.'",
            "Quoted: “a first paragraph.\n\nI can’t assist with that.”",
            "Quoted: «I cannot help with that.»",
            "Quoted: 「我无法提供这类代码。」",
        ] {
            let response =
                format!("Background.\n\n{example}\n\nThe implementation works correctly.");
            assert!(!is_refusal(&response), "{example}");
            assert!(
                is_refusal(&format!("{response}\n\nI cannot assist with this request.")),
                "{example}"
            );
        }
    }

    #[test]
    fn punctuation_does_not_hide_a_later_refusal() {
        for prefix in [
            "The developers' notes describe a 12\" screen.",
            "The user's message is “I can’t help with that.”",
            "A quoted example is 'I won’t help with that.'",
            "Example: \"An unfinished quote",
        ] {
            assert!(
                is_refusal(&format!("{prefix}\n\nI cannot assist with this request.")),
                "{prefix}"
            );
        }
        assert!(!is_refusal("I cannot `example` help with this."));
        assert!(!is_refusal("I cannot \"example\" help with this."));
    }
}
