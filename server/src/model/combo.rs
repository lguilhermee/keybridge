//! Defines combos: one Cursor model-picker name that stands for several models.
use std::{collections::HashSet, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Prefix that separates combo ids from API-key model hashes and provider model ids.
pub const COMBO_ID_PREFIX: &str = "combo:";

pub fn is_combo_id(model_id: &str) -> bool {
    model_id.starts_with(COMBO_ID_PREFIX)
}

/// Which member takes a run first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComboStrategy {
    /// Always the first member.
    Ordered,
    /// Each run starts one member later than the previous run.
    Loop,
    /// A random member.
    Random,
}

impl ComboStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ordered => "ordered",
            Self::Loop => "loop",
            Self::Random => "random",
        }
    }
}

impl FromStr for ComboStrategy {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "ordered" => Ok(Self::Ordered),
            "loop" => Ok(Self::Loop),
            "random" => Ok(Self::Random),
            other => Err(Error::Config(format!("unknown combo strategy: {other}"))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComboInput {
    pub display_name: String,
    pub strategy: ComboStrategy,
    /// Member model ids in fallback order.
    pub members: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ComboConfig {
    pub combo_id: String,
    pub sort_order: i64,
    pub display_name: String,
    pub strategy: ComboStrategy,
    pub members: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub fn normalize_combo_input(input: &ComboInput) -> Result<ComboInput> {
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err(Error::Config("combo name is required".into()));
    }
    if input.members.is_empty() {
        return Err(Error::Config("a combo needs at least one member".into()));
    }
    let mut seen = HashSet::with_capacity(input.members.len());
    let mut members = Vec::with_capacity(input.members.len());
    for member in &input.members {
        let member = member.trim();
        if member.is_empty() || is_combo_id(member) {
            return Err(Error::Config(format!("invalid combo member: {member:?}")));
        }
        if !seen.insert(member) {
            return Err(Error::Config(format!("duplicate combo member: {member}")));
        }
        members.push(member.to_owned());
    }
    Ok(ComboInput {
        display_name: display_name.to_owned(),
        strategy: input.strategy,
        members,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, members: &[&str]) -> ComboInput {
        ComboInput {
            display_name: name.into(),
            strategy: ComboStrategy::Ordered,
            members: members.iter().map(|member| (*member).into()).collect(),
        }
    }

    #[test]
    fn normalizing_trims_and_keeps_member_order() {
        let normalized = normalize_combo_input(&input(" Best ", &[" b ", "a"])).unwrap();
        assert_eq!(normalized.display_name, "Best");
        assert_eq!(normalized.members, ["b", "a"]);
    }

    #[test]
    fn rejects_empty_duplicate_and_nested_members() {
        assert!(normalize_combo_input(&input("", &["a"])).is_err());
        assert!(normalize_combo_input(&input("x", &[])).is_err());
        assert!(normalize_combo_input(&input("x", &["a", "a"])).is_err());
        assert!(normalize_combo_input(&input("x", &["combo:abc"])).is_err());
    }
}
