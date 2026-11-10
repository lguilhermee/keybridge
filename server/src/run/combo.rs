//! Resolves a combo to its members for one run and picks the fallback member.
use crate::{
    model::{is_combo_id, ComboStrategy, ModelSpec, PreparedRun},
    store::Store,
};

use super::{FailureKind, ModelCycleFailure, RunFailure};

/// The members a run may use, in fallback order, and the one currently answering.
///
/// The current member stays for the rest of the run once it answers; each model
/// call may try every member once before the run fails.
#[derive(Debug)]
pub(super) struct ComboRun {
    name: String,
    members: Vec<String>,
    current: usize,
    failed_this_call: usize,
}

impl ComboRun {
    /// Returns `None` when the selected model is not a combo.
    pub(super) async fn start(store: &Store, model_id: &str) -> Result<Option<Self>, RunFailure> {
        if !is_combo_id(model_id) {
            return Ok(None);
        }
        let (combo, previous_runs) = store
            .start_combo_run(model_id)
            .await?
            .ok_or_else(|| RunFailure::Provider(format!("unknown combo: {model_id}")))?;
        if combo.members.is_empty() {
            return Err(RunFailure::Provider(format!(
                "combo {} has no members",
                combo.display_name
            )));
        }
        let current = first_member(
            combo.strategy,
            combo.members.len(),
            previous_runs,
            uuid::Uuid::new_v4().as_u128(),
        );
        tracing::info!(
            combo = %combo.display_name,
            strategy = combo.strategy.as_str(),
            member = %combo.members[current],
            "combo selected its first member"
        );
        Ok(Some(Self {
            name: combo.display_name,
            members: combo.members,
            current,
            failed_this_call: 0,
        }))
    }

    pub(super) fn call_succeeded(&mut self) {
        self.failed_this_call = 0;
    }

    /// Moves to the next member after a failure no retry can fix. Returns the
    /// new member, or `None` when the failure is final or every member failed.
    pub(super) fn fallback(&mut self, failure: &ModelCycleFailure) -> Option<&str> {
        if failure.kind == FailureKind::Final {
            return None;
        }
        self.failed_this_call += 1;
        if self.failed_this_call >= self.members.len() {
            return None;
        }
        let from = self.current;
        self.current = (self.current + 1) % self.members.len();
        tracing::warn!(
            combo = %self.name,
            from = %self.members[from],
            to = %self.members[self.current],
            kind = ?failure.kind,
            "combo member failed; falling back"
        );
        Some(&self.members[self.current])
    }
}

/// The model for the next call: the run's selection, with the current combo
/// member in place of the combo.
pub(super) fn run_model(prepared: &PreparedRun, combo: Option<&ComboRun>) -> ModelSpec {
    let mut model = prepared.model.clone();
    if let Some(combo) = combo {
        model.model_id = combo.members[combo.current].clone();
    }
    model
}

fn first_member(
    strategy: ComboStrategy,
    members: usize,
    previous_runs: u64,
    random: u128,
) -> usize {
    match strategy {
        ComboStrategy::Ordered => 0,
        ComboStrategy::Loop => (previous_runs % members as u64) as usize,
        ComboStrategy::Random => (random % members as u128) as usize,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn combo(members: &[&str]) -> ComboRun {
        ComboRun {
            name: "combo".into(),
            members: members.iter().map(|member| (*member).into()).collect(),
            current: 0,
            failed_this_call: 0,
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
    fn strategies_pick_the_first_member() {
        assert_eq!(first_member(ComboStrategy::Ordered, 3, 7, 5), 0);
        assert_eq!(first_member(ComboStrategy::Loop, 3, 0, 5), 0);
        assert_eq!(first_member(ComboStrategy::Loop, 3, 4, 5), 1);
        assert_eq!(first_member(ComboStrategy::Random, 3, 0, 5), 2);
    }

    #[test]
    fn falls_back_through_every_member_once_per_call() {
        let mut run = combo(&["a", "b", "c"]);
        run.current = 1;
        let refusal = failure(FailureKind::Refusal);
        assert_eq!(run.fallback(&refusal), Some("c"));
        assert_eq!(run.fallback(&failure(FailureKind::Rejected)), Some("a"));
        assert_eq!(run.fallback(&failure(FailureKind::Temporary)), None);

        run.call_succeeded();
        assert_eq!(run.fallback(&refusal), Some("b"));
    }

    #[test]
    fn final_failures_never_fall_back() {
        let mut run = combo(&["a", "b"]);
        assert_eq!(run.fallback(&failure(FailureKind::Final)), None);
        assert_eq!(run.members[run.current], "a");
    }
}
