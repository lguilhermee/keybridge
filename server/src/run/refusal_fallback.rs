//! Sends a refused call to the refusing model's refusal model for the rest of one run.
use std::collections::HashMap;

use crate::{model::ModelSpec, store::Store};

use super::{FailureKind, ModelCycleFailure, RunFailure};

/// Refusal models configured when the run started, and the one answering now.
///
/// Each run starts without a refusal model, so the next request goes back to
/// the model the user picked.
#[derive(Debug, Default)]
pub(super) struct RefusalRun {
    fallbacks: HashMap<String, String>,
    active: Option<String>,
}

impl RefusalRun {
    pub(super) async fn start(store: &Store) -> Result<Self, RunFailure> {
        Ok(Self {
            fallbacks: store.refusal_fallback_map().await?,
            active: None,
        })
    }

    /// Switches to the refusal model of `refused_model` when `failure` is a
    /// refusal and no refusal model is answering yet. Returns the refusal model.
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
            "model refused; switching to its refusal model for this run"
        );
        self.active = Some(fallback.clone());
        Some(fallback)
    }

    /// The refusal model failed as well; the run's own model choice answers again.
    pub(super) fn release(&mut self) {
        self.active = None;
    }

    /// `model` with the answering refusal model in its place, if any.
    pub(super) fn apply(&self, mut model: ModelSpec) -> ModelSpec {
        if let Some(active) = &self.active {
            model.model_id = active.clone();
        }
        model
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(fallbacks: &[(&str, &str)]) -> RefusalRun {
        RefusalRun {
            fallbacks: fallbacks
                .iter()
                .map(|(from, to)| ((*from).into(), (*to).into()))
                .collect(),
            active: None,
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
    fn only_refusals_of_configured_models_switch() {
        let mut refusal = run(&[("a", "r")]);
        assert_eq!(refusal.switch("a", &failure(FailureKind::Rejected)), None);
        assert_eq!(refusal.switch("b", &failure(FailureKind::Refusal)), None);
        assert_eq!(refusal.apply(ModelSpec::new("a")).model_id, "a");

        assert_eq!(
            refusal.switch("a", &failure(FailureKind::Refusal)),
            Some("r".into())
        );
        assert_eq!(refusal.apply(ModelSpec::new("a")).model_id, "r");
    }

    #[test]
    fn a_refusing_refusal_model_hands_back_to_the_run() {
        let mut refusal = run(&[("a", "r"), ("r", "s")]);
        refusal.switch("a", &failure(FailureKind::Refusal));
        assert_eq!(refusal.switch("r", &failure(FailureKind::Refusal)), None);
        refusal.release();
        assert_eq!(refusal.apply(ModelSpec::new("a")).model_id, "a");
    }
}
