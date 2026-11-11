//! Sends a refused model call to the refusing model's refusal model.
//!
//! The refusal model answers only the call that was refused. The next model
//! call of the run goes back to the run's own model, and falls back again if
//! that model refuses again.
use std::collections::HashMap;

use crate::{model::ModelSpec, store::Store};

use super::{FailureKind, ModelCycleFailure, RunFailure};

/// Refusal models configured when the run started.
#[derive(Debug, Default)]
pub(super) struct RefusalFallbacks {
    fallbacks: HashMap<String, String>,
}

impl RefusalFallbacks {
    pub(super) async fn load(store: &Store) -> Result<Self, RunFailure> {
        Ok(Self {
            fallbacks: store.refusal_fallback_map().await?,
        })
    }

    /// Refusal state for one model call; starts on the run's own model.
    pub(super) fn call(&self) -> RefusalCall<'_> {
        RefusalCall {
            fallbacks: &self.fallbacks,
            active: None,
        }
    }
}

/// The refusal model answering the current model call, if any.
#[derive(Debug)]
pub(super) struct RefusalCall<'a> {
    fallbacks: &'a HashMap<String, String>,
    active: Option<String>,
}

impl RefusalCall<'_> {
    /// Switches to the refusal model of `refused_model` when `failure` is a
    /// refusal and no refusal model is answering this call yet. Returns the
    /// refusal model.
    pub(super) fn switch(
        &mut self,
        refused_model: &str,
        failure: &ModelCycleFailure,
    ) -> Option<String> {
        if failure.kind != FailureKind::Refusal || self.active.is_some() {
            return None;
        }
        let fallback = self.fallbacks.get(refused_model)?.clone();
        tracing::warn!(
            from = %refused_model,
            to = %fallback,
            "model refused; switching to its refusal model for this call"
        );
        self.active = Some(fallback.clone());
        Some(fallback)
    }

    /// The refusal model failed as well; the run's own model choice answers.
    pub(super) fn release(&mut self) {
        self.active = None;
    }

    /// Whether a refusal by `model` would switch this call to the refusal
    /// model, so its replies are read for refusals.
    pub(super) fn watches(&self, model: &str) -> bool {
        self.active.is_none() && self.fallbacks.contains_key(model)
    }

    /// Keep the client's settings on its selected model. A refusal model starts
    /// fresh so routing applies its own saved settings and provider defaults.
    pub(super) fn apply(&self, model: ModelSpec) -> ModelSpec {
        match &self.active {
            Some(active) => ModelSpec::new(active),
            None => model,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fallbacks(pairs: &[(&str, &str)]) -> RefusalFallbacks {
        RefusalFallbacks {
            fallbacks: pairs
                .iter()
                .map(|(from, to)| ((*from).into(), (*to).into()))
                .collect(),
        }
    }

    fn failure(kind: FailureKind) -> ModelCycleFailure {
        ModelCycleFailure {
            failure: RunFailure::Refusal("no".into()),
            partial_text: String::new(),
            partial_reasoning: String::new(),
            usage: None,
            kind,
        }
    }

    #[test]
    fn refusal_model_does_not_inherit_client_settings() {
        let fallbacks = fallbacks(&[("a", "r")]);
        let mut call = fallbacks.call();
        let mut selected = ModelSpec::new("a");
        selected.display_name = Some("Cursor model".into());
        selected.reasoning.enabled = true;
        selected.reasoning.effort = Some("medium".into());
        selected.latency = crate::model::ModelLatency::Fast;
        selected.max_output_tokens = Some(32_000);
        selected.context_window_tokens = Some(1_000_000);
        selected.supports_image_generation = true;
        selected.extra_params = serde_json::json!({"reasoning": {"effort": "medium"}});

        assert_eq!(call.apply(selected.clone()), selected);
        call.switch("a", &failure(FailureKind::Refusal));
        assert_eq!(call.apply(selected.clone()), ModelSpec::new("r"));
        call.release();
        assert_eq!(call.apply(selected.clone()), selected);
    }

    #[test]
    fn only_refusals_of_configured_models_switch() {
        let fallbacks = fallbacks(&[("a", "r")]);
        let mut call = fallbacks.call();
        assert_eq!(call.switch("a", &failure(FailureKind::Rejected)), None);
        assert_eq!(call.switch("b", &failure(FailureKind::Refusal)), None);
        assert_eq!(call.apply(ModelSpec::new("a")).model_id, "a");
        assert_eq!(
            call.switch("a", &failure(FailureKind::Refusal)),
            Some("r".into())
        );
        assert_eq!(call.apply(ModelSpec::new("a")).model_id, "r");
    }

    #[test]
    fn a_refusing_refusal_model_hands_back_to_the_run() {
        let fallbacks = fallbacks(&[("a", "r"), ("r", "s")]);
        let mut call = fallbacks.call();
        call.switch("a", &failure(FailureKind::Refusal));
        assert_eq!(call.switch("r", &failure(FailureKind::Refusal)), None);
        call.release();
        assert_eq!(call.apply(ModelSpec::new("a")).model_id, "a");
    }

    #[test]
    fn the_next_call_goes_back_to_the_refused_model() {
        let fallbacks = fallbacks(&[("a", "r")]);
        let mut refused = fallbacks.call();
        refused.switch("a", &failure(FailureKind::Refusal));
        assert_eq!(refused.apply(ModelSpec::new("a")).model_id, "r");

        let mut next = fallbacks.call();
        assert_eq!(next.apply(ModelSpec::new("a")).model_id, "a");
        assert_eq!(
            next.switch("a", &failure(FailureKind::Refusal)),
            Some("r".into())
        );
    }
}
