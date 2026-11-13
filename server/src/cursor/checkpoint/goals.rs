//! Persists successful goal tool changes in Cursor's continuation state.
use crate::cursor::{checkpoint::PendingSteps, protocol::proto::agent::v1 as pb};

use super::CheckpointBuilder;

impl CheckpointBuilder {
    pub(super) fn record_goal_changes(&mut self, presentation: &PendingSteps) {
        for step in &presentation.steps {
            let Some(pb::conversation_step::Message::ToolCall(call)) = step.message.as_ref() else {
                continue;
            };
            let now = call
                .completed_at_ms
                .unwrap_or_else(crate::cursor::tools::runtime::now_ms);
            match call.tool.as_ref() {
                Some(pb::tool_call::Tool::CreateGoalToolCall(tool)) => {
                    if !matches!(
                        tool.result
                            .as_ref()
                            .and_then(|result| result.result.as_ref()),
                        Some(pb::create_goal_result::Result::Success(_))
                    ) {
                        continue;
                    }
                    let Some(args) = tool
                        .args
                        .as_ref()
                        .filter(|args| !args.objective.trim().is_empty())
                    else {
                        continue;
                    };
                    self.base.goal_state = Some(pb::GoalState {
                        conversation_id: self.conversation_id.clone(),
                        goal_id: uuid::Uuid::new_v4().to_string(),
                        objective: args.objective.trim().into(),
                        status: pb::GoalStatus::Active as i32,
                        active_duration_ms: Some(0),
                        last_accrued_at_ms: Some(now),
                        agent_session_id: self.agent_session_id.clone(),
                        ..Default::default()
                    });
                }
                Some(pb::tool_call::Tool::UpdateGoalToolCall(tool)) => {
                    let Some(pb::update_goal_result::Result::Success(success)) = tool
                        .result
                        .as_ref()
                        .and_then(|result| result.result.as_ref())
                    else {
                        continue;
                    };
                    let Ok(status) = pb::GoalStatus::try_from(success.status) else {
                        continue;
                    };
                    if status == pb::GoalStatus::Cleared {
                        self.base.goal_state = None;
                        continue;
                    }
                    if status == pb::GoalStatus::Unspecified {
                        continue;
                    }
                    if let Some(goal) = self.base.goal_state.as_mut() {
                        if let Some(started) = goal.last_accrued_at_ms {
                            goal.active_duration_ms = Some(
                                goal.active_duration_ms
                                    .unwrap_or(0)
                                    .saturating_add(now.saturating_sub(started)),
                            );
                        }
                        goal.status = status as i32;
                        goal.last_accrued_at_ms = (status == pb::GoalStatus::Active).then_some(now);
                    }
                }
                _ => {}
            }
        }
    }
}
