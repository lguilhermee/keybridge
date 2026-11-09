//! Records finished background subagents in Cursor checkpoint state.
use std::{collections::HashMap, sync::Arc};

use crate::cursor::protocol::proto::agent::v1 as pb;

#[derive(Clone, Default)]
pub struct SubagentCompletions {
    finished: Arc<parking_lot::Mutex<HashMap<String, pb::SubagentRunState>>>,
}

impl SubagentCompletions {
    pub fn record(&self, action: &pb::BackgroundTaskCompletionAction, completed_at_ms: u64) {
        let mut finished = self.finished.lock();
        for completion in &action.completions {
            if completion.kind != pb::BackgroundTaskKind::Subagent as i32
                || completion.reason != pb::BackgroundTaskCompletionReason::TaskFinished as i32
            {
                continue;
            }
            let Some(tool_call_id) = completion.tool_call_id.as_ref().filter(|id| !id.is_empty())
            else {
                continue;
            };
            let status = match pb::BackgroundTaskStatus::try_from(completion.status) {
                Ok(pb::BackgroundTaskStatus::Success) => pb::SubagentRunStatus::Success,
                Ok(pb::BackgroundTaskStatus::Error) => pb::SubagentRunStatus::Error,
                Ok(pb::BackgroundTaskStatus::Aborted) => pb::SubagentRunStatus::Aborted,
                Ok(pb::BackgroundTaskStatus::Unspecified) | Err(_) => continue,
            };
            finished
                .entry(tool_call_id.clone())
                .or_insert_with(|| pb::SubagentRunState {
                    parent_tool_call_id: tool_call_id.clone(),
                    subagent_id: completion.subagent_id.clone(),
                    status: status as i32,
                    title: Some(completion.title.clone()).filter(|title| !title.is_empty()),
                    detail: completion.detail.clone(),
                    output_path: completion.output_path.clone(),
                    completed_timestamp_ms: Some(completed_at_ms),
                    completion_reason: Some(
                        pb::BackgroundTaskCompletionReason::TaskFinished as i32,
                    ),
                    ..Default::default()
                });
        }
    }

    pub fn apply(&self, runs: &mut HashMap<String, pb::SubagentRunState>) {
        for (tool_call_id, finished) in self.finished.lock().iter() {
            let run = runs
                .entry(tool_call_id.clone())
                .or_insert_with(|| finished.clone());
            run.status = finished.status;
            run.completed_timestamp_ms = finished.completed_timestamp_ms;
            run.completion_reason = finished.completion_reason;
            if run.subagent_id.is_none() {
                run.subagent_id = finished.subagent_id.clone();
            }
            if finished.detail.is_some() {
                run.detail = finished.detail.clone();
            }
            if finished.output_path.is_some() {
                run.output_path = finished.output_path.clone();
            }
        }
    }
}
