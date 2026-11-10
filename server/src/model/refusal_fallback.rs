//! Defines refusal fallbacks: the model that answers when a model refuses.
use serde::{Deserialize, Serialize};

use super::is_combo_id;
use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusalFallback {
    /// API-key model hash or provider model id that may refuse.
    pub model_id: String,
    /// Model that answers instead for the rest of that run.
    pub fallback_model_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct RefusalFallbackInput {
    pub model_id: String,
    /// `None` turns the fallback off.
    pub fallback_model_id: Option<String>,
}

/// Returns the trimmed input, or an error when either side is empty, a combo,
/// or both sides name the same model.
pub fn normalize_refusal_fallback_input(
    input: &RefusalFallbackInput,
) -> Result<RefusalFallbackInput> {
    let model_id = model_ref(&input.model_id)?;
    let fallback_model_id = input
        .fallback_model_id
        .as_deref()
        .map(model_ref)
        .transpose()?;
    if fallback_model_id.as_deref() == Some(model_id.as_str()) {
        return Err(Error::Config(
            "a model cannot be its own refusal model".into(),
        ));
    }
    Ok(RefusalFallbackInput {
        model_id,
        fallback_model_id,
    })
}

fn model_ref(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || is_combo_id(value) {
        return Err(Error::Config(format!(
            "invalid refusal fallback model: {value:?}"
        )));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(model_id: &str, fallback: Option<&str>) -> RefusalFallbackInput {
        RefusalFallbackInput {
            model_id: model_id.into(),
            fallback_model_id: fallback.map(String::from),
        }
    }

    #[test]
    fn trims_both_sides() {
        assert_eq!(
            normalize_refusal_fallback_input(&input(" a ", Some(" b "))).unwrap(),
            input("a", Some("b"))
        );
        assert_eq!(
            normalize_refusal_fallback_input(&input("a", None)).unwrap(),
            input("a", None)
        );
    }

    #[test]
    fn rejects_empty_combo_and_self_fallbacks() {
        assert!(normalize_refusal_fallback_input(&input("", Some("b"))).is_err());
        assert!(normalize_refusal_fallback_input(&input("a", Some(" "))).is_err());
        assert!(normalize_refusal_fallback_input(&input("combo:x", Some("b"))).is_err());
        assert!(normalize_refusal_fallback_input(&input("a", Some("combo:x"))).is_err());
        assert!(normalize_refusal_fallback_input(&input("a", Some(" a"))).is_err());
    }
}
