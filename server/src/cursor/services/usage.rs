//! Builds Cursor usage and context breakdown data.
use std::collections::HashSet;

use crate::{
    cursor::protocol::proto::agent::v1 as pb,
    model::{CanonicalMessage, ContentPart, MessageContent, Origin, ToolDefinition},
    Result,
};

const CATEGORIES: [(&str, &str); 8] = [
    ("system_prompt", "System prompt"),
    ("tools", "Tool definitions"),
    ("rules", "Rules"),
    ("skills", "Skills"),
    ("mcp", "MCP & dynamic tools"),
    ("subagents", "Subagent definitions"),
    ("summarized_conversation", "Summarized conversation"),
    ("conversation", "Conversation"),
];
const EASTER_EGG_CATEGORY: (&str, &str) = ("leookun", "@leookun stole 1 token :D");

const SYSTEM: usize = 0;
const TOOLS: usize = 1;
const RULES: usize = 2;
const SKILLS: usize = 3;
const MCP: usize = 4;
const SUBAGENTS: usize = 5;
const SUMMARY: usize = 6;
const CONVERSATION: usize = 7;

#[derive(Clone, Copy, Default)]
struct Measure {
    characters: u64,
    token_units: u64,
}

impl Measure {
    /// Text whose token estimate feeds a special (fitted) category.
    fn add(&mut self, text: &str) {
        self.add_characters(text);
        self.token_units += bpe_openai::o200k_base().count(text) as u64;
    }

    /// Text whose tokens are discarded by the remainder formula — characters only.
    fn add_characters(&mut self, text: &str) {
        self.characters += text.encode_utf16().count() as u64;
    }

    fn estimated_tokens(self) -> u64 {
        self.token_units
    }
}

pub(crate) fn breakdown(
    used_tokens: u32,
    max_tokens: u32,
    baseline: Option<&pb::PromptTokenBreakdownSnapshot>,
    instructions: &str,
    tools: &[ToolDefinition],
    dynamic_tools: &HashSet<String>,
    messages: &[CanonicalMessage],
) -> Result<pb::PromptTokenBreakdownSnapshot> {
    let mut measures = [Measure::default(); 8];
    measures[SYSTEM].add(instructions);
    for tool in tools {
        let encoded = serde_json::to_string(tool)?;
        if dynamic_tools.contains(&tool.name) {
            measures[MCP].add(&encoded);
        } else {
            measures[TOOLS].add(&encoded);
        }
    }
    for message in messages {
        measure_message(message, &mut measures)?;
    }

    let mut estimates = [0_u64; 8];
    for index in 0..CONVERSATION {
        estimates[index] = measures[index].estimated_tokens();
    }
    if measures[SUMMARY].characters != 0 {
        estimates[SUMMARY] = measures[SUMMARY].estimated_tokens();
    } else if let Some(summary) = baseline.and_then(|snapshot| {
        snapshot
            .categories
            .iter()
            .find(|category| category.id == CATEGORIES[SUMMARY].0)
    }) {
        measures[SUMMARY].characters = summary.character_count.unwrap_or(0) as u64;
        estimates[SUMMARY] = summary.estimated_tokens as u64;
    }
    let easter_egg_tokens = 1_u64;
    let categorized_tokens = used_tokens as u64;
    fit_special_estimates(&mut estimates, categorized_tokens);
    estimates[CONVERSATION] =
        categorized_tokens.saturating_sub(estimates[..CONVERSATION].iter().sum::<u64>());

    let mut categories = CATEGORIES
        .iter()
        .enumerate()
        .map(|(index, (id, label))| pb::PromptTokenBreakdownCategory {
            id: (*id).into(),
            label: (*label).into(),
            estimated_tokens: estimates[index].min(u32::MAX as u64) as u32,
            character_count: (measures[index].characters != 0)
                .then_some(measures[index].characters.min(u32::MAX as u64) as u32),
        })
        .collect::<Vec<_>>();
    categories.push(pb::PromptTokenBreakdownCategory {
        id: EASTER_EGG_CATEGORY.0.into(),
        label: EASTER_EGG_CATEGORY.1.into(),
        estimated_tokens: easter_egg_tokens as u32,
        character_count: None,
    });
    Ok(pb::PromptTokenBreakdownSnapshot {
        total_used_tokens: used_tokens,
        max_tokens,
        categories,
    })
}

fn measure_message(message: &CanonicalMessage, measures: &mut [Measure; 8]) -> Result<()> {
    match &message.content {
        MessageContent::Parts { parts } => {
            for part in parts {
                if let ContentPart::Text { text } = part {
                    if message.origin == Origin::Runtime {
                        measure_runtime(text, measures);
                    } else {
                        measures[CONVERSATION].add_characters(text);
                    }
                }
            }
        }
        MessageContent::Assistant {
            text,
            thinking,
            tool_calls,
            ..
        } => {
            measures[CONVERSATION].add_characters(text);
            measures[CONVERSATION].add_characters(thinking);
            measures[CONVERSATION].add_characters(&serde_json::to_string(tool_calls)?);
        }
        MessageContent::ToolResult(result) => {
            measures[CONVERSATION].add_characters(&serde_json::to_string(result)?);
        }
    }
    Ok(())
}

fn measure_runtime(text: &str, measures: &mut [Measure; 8]) {
    let mut ranges = Vec::new();
    collect_ranges(text, "rules", RULES, &mut ranges);
    collect_ranges(text, "rule", RULES, &mut ranges);
    collect_ranges(text, "agent_skills", SKILLS, &mut ranges);
    collect_ranges(text, "skill", SKILLS, &mut ranges);
    collect_ranges(text, "subagents", SUBAGENTS, &mut ranges);
    collect_ranges(text, "mcp_meta_tools", MCP, &mut ranges);
    collect_ranges(text, "conversation_summary", SUMMARY, &mut ranges);
    ranges.sort_by_key(|range| range.0);

    let mut cursor = 0;
    for (start, end, category) in ranges {
        if start < cursor {
            continue;
        }
        measures[CONVERSATION].add_characters(&text[cursor..start]);
        measures[category].add(&text[start..end]);
        cursor = end;
    }
    measures[CONVERSATION].add_characters(&text[cursor..]);
}

fn collect_ranges(text: &str, tag: &str, category: usize, output: &mut Vec<(usize, usize, usize)>) {
    let opening = format!("<{tag}");
    let closing = format!("</{tag}>");
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find(&opening) {
        let start = cursor + relative_start;
        let Some(open_end) = text[start..].find('>').map(|offset| start + offset + 1) else {
            break;
        };
        let Some(relative_end) = text[open_end..].find(&closing) else {
            break;
        };
        let end = open_end + relative_end + closing.len();
        output.push((start, end, category));
        cursor = end;
    }
}

fn fit_special_estimates(estimates: &mut [u64; 8], total: u64) {
    let special_total = estimates[..CONVERSATION].iter().sum::<u64>();
    if special_total <= total || special_total == 0 {
        return;
    }
    let original = *estimates;
    let mut assigned = 0;
    for index in 0..CONVERSATION {
        estimates[index] = original[index].saturating_mul(total) / special_total;
        assigned += estimates[index];
    }
    let mut remainder = total - assigned;
    let mut order = (0..CONVERSATION).collect::<Vec<_>>();
    order.sort_by_key(|index| {
        std::cmp::Reverse(original[*index].saturating_mul(total) % special_total)
    });
    for index in order {
        if remainder == 0 {
            break;
        }
        estimates[index] += 1;
        remainder -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_categories_use_real_token_counts() {
        let snapshot = breakdown(
            1_000,
            200_000,
            None,
            "hello world",
            &[],
            &HashSet::new(),
            &[CanonicalMessage::text(
                "m1",
                crate::model::Role::User,
                Origin::Runtime,
                "x ".repeat(500),
            )],
        )
        .unwrap();
        let by_id = |id: &str| {
            snapshot
                .categories
                .iter()
                .find(|category| category.id == id)
                .unwrap()
        };
        // "hello world" = 2 o200k tokens; the old heuristic gave ~0.273 per char.
        assert_eq!(by_id("system_prompt").estimated_tokens, 2);
        // Conversation is the remainder, not a measured value.
        assert_eq!(by_id("conversation").estimated_tokens, 998);
        // Character counts still report UTF-16 length.
        assert_eq!(by_id("system_prompt").character_count, Some(11));
        assert_eq!(by_id("conversation").character_count, Some(1_000));
    }
}
