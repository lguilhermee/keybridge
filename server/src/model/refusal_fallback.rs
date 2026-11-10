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
pub struct RefusalFallbacksInput {
    pub fallbacks: Vec<RefusalFallback>,
}

/// Returns trimmed, unique refusal fallbacks, or an error when either side is
/// empty, a combo, duplicated, or both sides name the same model.
pub fn normalize_refusal_fallbacks(fallbacks: &[RefusalFallback]) -> Result<Vec<RefusalFallback>> {
    let mut seen = std::collections::BTreeSet::new();
    let mut normalized = Vec::with_capacity(fallbacks.len());
    for fallback in fallbacks {
        let model_id = model_ref(&fallback.model_id)?;
        let fallback_model_id = model_ref(&fallback.fallback_model_id)?;
        if model_id == fallback_model_id {
            return Err(Error::Config(
                "a model cannot be its own refusal model".into(),
            ));
        }
        if !seen.insert(model_id.clone()) {
            return Err(Error::Config(format!(
                "duplicate refusal fallback source model: {model_id}"
            )));
        }
        normalized.push(RefusalFallback {
            model_id,
            fallback_model_id,
        });
    }
    Ok(normalized)
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

    fn pair(model_id: &str, fallback_model_id: &str) -> RefusalFallback {
        RefusalFallback {
            model_id: model_id.into(),
            fallback_model_id: fallback_model_id.into(),
        }
    }

    #[test]
    fn trims_both_sides_and_allows_empty_list() {
        assert_eq!(
            normalize_refusal_fallbacks(&[pair(" a ", " b ")]).unwrap(),
            vec![pair("a", "b")]
        );
        assert_eq!(normalize_refusal_fallbacks(&[]).unwrap(), Vec::new());
    }

    #[test]
    fn rejects_empty_combo_duplicate_and_self_fallbacks() {
        assert!(normalize_refusal_fallbacks(&[pair("", "b")]).is_err());
        assert!(normalize_refusal_fallbacks(&[pair("a", " ")]).is_err());
        assert!(normalize_refusal_fallbacks(&[pair("combo:x", "b")]).is_err());
        assert!(normalize_refusal_fallbacks(&[pair("a", "combo:x")]).is_err());
        assert!(normalize_refusal_fallbacks(&[pair("a", " a")]).is_err());
        assert!(normalize_refusal_fallbacks(&[pair("a", "b"), pair(" a ", "c")]).is_err());
    }
}
