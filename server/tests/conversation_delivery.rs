//! Verifies message delivery before, during, and after a Run.
#[path = "support/fake_protocol.rs"]
mod fake_protocol;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::HashMap, sync::Arc};

use cursor_server::{
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        protocol::connect,
        protocol::proto::agent::v1 as pb,
        TransportCommand, TransportHandle, TransportRegistry,
    },
    model::{ContentPart, MessageContent, ProjectedContent, Role},
    protocol::{FinishReason, ModelEvent},
};
use prost::Message;

const FOLLOW_UP: &str = "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required. If you mention an agent or subagent in your response, link it with the `[Name](id)` Don't use generic label such as `[agent]`, `[worker]`, or `[subagent]`.";
const SHELL_FOLLOW_UP: &str = "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.";

fn user_run(text: &str, id: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                conversation_id: Some("parent-conversation".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: text.into(),
                                message_id: id.into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    }
}

#[tokio::test]
async fn background_completion_after_stop_waits_for_a_new_user_message() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response(
        "stop-answer",
        "Stopped. I won't take any further action.",
    ));
    protocol.push(stop_response(
        "resume-answer",
        "Continuing at your request.",
    ));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let first = registry.get_or_create("user-stop").await.unwrap();
    drive_completion(&first, user_run("stop, seriously", "stop-message")).await;
    let stopped_history = protocol.requests()[0].history.clone();

    let discord = registry.get_or_create("discord-after-stop").await.unwrap();
    drive_forwarded_completion(
        &discord,
        user_run(
            "<nuia_discord_request>\n{\"request\":\"continue\"}\n</nuia_discord_request>",
            "discord-message",
        ),
    )
    .await;
    assert_eq!(
        protocol.requests().len(),
        1,
        "Discord delivery cleared the explicit pause"
    );

    for request_id in ["late-completion", "retried-late-completion"] {
        let completion = registry.get_or_create(request_id).await.unwrap();
        drive_forwarded_completion(
            &completion,
            completion_run(
                "late-child",
                request_id,
                pb::ConversationStateStructure::default(),
            ),
        )
        .await;
        assert_eq!(
            protocol.requests().len(),
            1,
            "background completion restarted the stopped agent"
        );
    }

    let mut reconnect = user_run("unused", "unused");
    if let Some(pb::agent_client_message::Message::RunRequest(request)) = reconnect.message.as_mut()
    {
        request.action = Some(pb::ConversationAction {
            action: Some(pb::conversation_action::Action::ResumeAction(
                pb::ResumeAction::default(),
            )),
            ..Default::default()
        });
    }
    let resumed_transport = registry.get_or_create("automatic-reconnect").await.unwrap();
    drive_forwarded_completion(&resumed_transport, reconnect).await;
    assert_eq!(
        protocol.requests().len(),
        1,
        "reconnecting bypassed the conversation pause"
    );

    let next = registry.get_or_create("explicit-continue").await.unwrap();
    drive_completion(&next, user_run("continue the work", "continue-message")).await;
    let requests = protocol.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        stopped_history,
        requests[1].history[..stopped_history.len()]
    );
    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "parent-conversation",
        ))
        .await
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|m| m.runtime_event_id.as_deref()
                == Some("background-completed:BACKGROUND_TASK_KIND_SUBAGENT:late-child:task-call"))
            .count(),
        1
    );
}

#[tokio::test]
async fn background_subagent_completion_starts_a_simulated_parent_turn() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response("model-call", "followed up"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("completion-request").await.unwrap();
    let (checkpoint, blobs) = drive_completion(
        &handle,
        completion_run(
            "child-id",
            "reusable-parent-run",
            pb::ConversationStateStructure {
                mode: Some(pb::AgentMode::Multitask as i32),
                ..Default::default()
            },
        ),
    )
    .await;

    let requests = protocol.requests();
    assert_eq!(requests.len(), 1);
    let [runtime] = requests[0].history.as_slice() else {
        panic!("completion Run must add exactly one runtime message")
    };
    assert_eq!(runtime.role, Role::User);
    let ProjectedContent::Parts(parts) = &runtime.content else {
        panic!("completion context must be text")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("completion context must have one text part")
    };
    assert!(text.contains("kind: subagent"));
    assert!(text.contains("agent_id: child-id"));
    assert!(text.contains("child result"));
    assert!(text.contains(FOLLOW_UP));

    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "parent-conversation",
        ))
        .await
        .unwrap();
    assert!(messages.iter().any(|message| {
        message.runtime_event_id.as_deref()
            == Some("background-completed:BACKGROUND_TASK_KIND_SUBAGENT:child-id:task-call")
            && matches!(&message.content, MessageContent::Parts { parts } if !parts.is_empty())
    }));

    let turn = pb::ConversationTurnStructure::decode(
        blobs
            .get(checkpoint.turns.last().expect("completion Turn"))
            .expect("completion Turn Blob")
            .as_slice(),
    )
    .unwrap();
    let pb::conversation_turn_structure::Turn::AgentConversationTurn(turn) = turn.turn.unwrap()
    else {
        panic!("expected agent conversation Turn")
    };
    let user = pb::UserMessage::decode(
        blobs
            .get(&turn.user_message)
            .expect("simulated UserMessage Blob")
            .as_slice(),
    )
    .unwrap();
    assert!(user.text.contains(FOLLOW_UP));
    assert_eq!(user.is_simulated_msg, Some(true));
    assert_eq!(
        user.simulated_msg_reason,
        Some(pb::SimulatedMsgReason::BackgroundTaskCompletion as i32)
    );
    assert_eq!(
        user.simulated_message_metadata.unwrap().task_id.as_deref(),
        Some("child-id")
    );

    protocol.push(stop_response("model-call-2", "followed up again"));
    let second = registry
        .get_or_create("completion-request-2")
        .await
        .unwrap();
    drive_completion(
        &second,
        completion_run("child-id-2", "reusable-parent-run-2", checkpoint),
    )
    .await;

    let requests = protocol.requests();
    assert_eq!(requests.len(), 2);
    let runtime_ids = requests[1]
        .history
        .iter()
        .map(|message| message.message_id.as_str())
        .filter(|id| id.starts_with("runtime:"))
        .collect::<Vec<_>>();
    assert_eq!(
        runtime_ids,
        [
            "runtime:background-completed:BACKGROUND_TASK_KIND_SUBAGENT:child-id:task-call",
            "runtime:background-completed:BACKGROUND_TASK_KIND_SUBAGENT:child-id-2:task-call"
        ]
    );
}

#[tokio::test]
async fn background_completion_joins_the_active_run_instead_of_replacing_it() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    let first_ready = protocol.push_gated(stop_response("model-call-1", "first response"));
    protocol.push(stop_response("model-call-2", "processed both completions"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let first = registry.get_or_create("active-completion-1").await.unwrap();
    let first_run = tokio::spawn(async move {
        drive_completion(
            &first,
            completion_run(
                "child-1",
                "parent-run-1",
                pb::ConversationStateStructure::default(),
            ),
        )
        .await
    });
    while protocol.requests().is_empty() {
        tokio::task::yield_now().await;
    }

    let second = registry.get_or_create("active-completion-2").await.unwrap();
    let second_run = tokio::spawn(async move {
        drive_forwarded_completion(
            &second,
            completion_run(
                "child-2",
                "parent-run-2",
                pb::ConversationStateStructure::default(),
            ),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    first_ready.notify_one();

    second_run.await.unwrap();
    first_run.await.unwrap();
    let requests = protocol.requests();
    assert_eq!(requests.len(), 2);
    let history = serde_json::to_string(&requests[1].history).unwrap();
    assert!(history.contains("child-1"));
    assert!(history.contains("first response"));
    assert!(history.contains("child-2"));
    let statuses: Vec<String> = sqlx::query_scalar(
        "SELECT status FROM runs WHERE conversation_id = 'parent-conversation' ORDER BY created_at_ms",
    )
    .fetch_all(store.pool())
    .await
    .unwrap();
    assert_eq!(statuses, ["completed"]);
}

fn test_registry(
    store: &cursor_server::store::Store,
    protocol: &fake_protocol::FakeProtocol,
) -> TransportRegistry {
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    )
}

#[tokio::test]
async fn background_completion_marks_the_subagent_finished_in_the_parent_checkpoint() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response("model-call", "followed up"));
    let registry = test_registry(&store, &protocol);
    let handle = registry.get_or_create("finished-subagent").await.unwrap();
    let (checkpoint, _) = drive_completion(
        &handle,
        completion_run(
            "child-id",
            "finished-subagent-run",
            backgrounded(&[("child-id", "task-call")]),
        ),
    )
    .await;
    assert_subagent_finished(&checkpoint, "task-call");
}

#[tokio::test]
async fn completion_joining_an_active_run_marks_the_subagent_finished() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    let first_ready = protocol.push_gated(stop_response("model-call-1", "first response"));
    protocol.push(stop_response("model-call-2", "processed both completions"));
    let registry = test_registry(&store, &protocol);
    let state = backgrounded(&[("child-1", "task-1"), ("child-2", "task-2")]);
    let first = registry.get_or_create("joined-completion-1").await.unwrap();
    let first_state = state.clone();
    let first_run = tokio::spawn(async move {
        drive_completion(
            &first,
            completion_run_for_call(
                "child-1",
                "task-1",
                "joined-run-1",
                first_state,
                "child result",
            ),
        )
        .await
    });
    while protocol.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    let second = registry.get_or_create("joined-completion-2").await.unwrap();
    let second_run = tokio::spawn(async move {
        drive_forwarded_completion(
            &second,
            completion_run_for_call("child-2", "task-2", "joined-run-2", state, "child result"),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    first_ready.notify_one();

    second_run.await.unwrap();
    let (checkpoint, _) = first_run.await.unwrap();
    assert_subagent_finished(&checkpoint, "task-1");
    assert_subagent_finished(&checkpoint, "task-2");
}

#[tokio::test]
async fn completion_after_stop_marks_the_subagent_finished_without_resuming() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response("stop-answer", "Stopped."));
    let registry = test_registry(&store, &protocol);
    let stop = registry
        .get_or_create("stop-before-completion")
        .await
        .unwrap();
    drive_completion(&stop, user_run("stop", "stop-message")).await;

    let completion = registry
        .get_or_create("completion-after-stop")
        .await
        .unwrap();
    let checkpoint = drive_forwarded_completion(
        &completion,
        completion_run(
            "late-child",
            "completion-after-stop",
            backgrounded(&[("late-child", "task-call")]),
        ),
    )
    .await
    .expect("a stopped parent must still record the finished subagent");
    assert_eq!(
        protocol.requests().len(),
        1,
        "completion resumed a stopped agent"
    );
    assert_subagent_finished(&checkpoint, "task-call");
}

#[tokio::test]
async fn retrying_one_background_completion_reuses_its_runtime_message() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response("model-call", "followed up"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let first = registry.get_or_create("completion-retry-1").await.unwrap();
    let (checkpoint, _) = drive_completion(
        &first,
        completion_run(
            "retry-child",
            "completion-retry-run-1",
            pb::ConversationStateStructure {
                mode: Some(pb::AgentMode::Multitask as i32),
                ..Default::default()
            },
        ),
    )
    .await;

    protocol.push(stop_response("model-call-2", "followed up again"));
    let second = registry.get_or_create("completion-retry-2").await.unwrap();
    drive_completion(
        &second,
        completion_run("retry-child", "completion-retry-run-2", checkpoint),
    )
    .await;

    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "parent-conversation",
        ))
        .await
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| {
                message.runtime_event_id.as_deref()
                    == Some(
                        "background-completed:BACKGROUND_TASK_KIND_SUBAGENT:retry-child:task-call",
                    )
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn background_shell_completion_wakes_the_parent_with_the_captured_notification() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response(
        "shell-wakeup",
        "The background server was stopped.",
    ));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry
        .get_or_create("shell-completion-request")
        .await
        .unwrap();
    let (checkpoint, blobs) = drive_completion(
        &handle,
        shell_completion_run(pb::ConversationStateStructure {
            mode: Some(pb::AgentMode::Agent as i32),
            ..Default::default()
        }),
    )
    .await;

    let requests = protocol.requests();
    let [runtime] = requests[0].history.as_slice() else {
        panic!("Shell completion Run must add exactly one runtime message")
    };
    let ProjectedContent::Parts(parts) = &runtime.content else {
        panic!("Shell completion context must be text")
    };
    let [ContentPart::Text { text }] = parts.as_slice() else {
        panic!("Shell completion context must have one text part")
    };
    assert!(text.contains("<system_notification>"));
    assert!(text.contains("kind: shell"));
    assert!(text.contains("status: aborted"));
    assert!(text.contains("task_id: 977679"));
    assert!(text.contains("detail: terminated_by_user"));
    assert!(text.contains("output_path: /tmp/977679.txt"));
    assert!(text.contains(SHELL_FOLLOW_UP));
    assert!(text.starts_with("<timestamp>"));
    assert!(!text.contains("You are still in **Agent Mode**"));
    assert!(text.find("<system_notification>").unwrap() < text.find("<user_query>").unwrap());

    let turn = pb::ConversationTurnStructure::decode(
        blobs
            .get(checkpoint.turns.last().expect("Shell completion Turn"))
            .expect("Shell completion Turn Blob")
            .as_slice(),
    )
    .unwrap();
    let pb::conversation_turn_structure::Turn::AgentConversationTurn(turn) = turn.turn.unwrap()
    else {
        panic!("expected agent conversation Turn")
    };
    let user = pb::UserMessage::decode(
        blobs
            .get(&turn.user_message)
            .expect("simulated Shell UserMessage Blob")
            .as_slice(),
    )
    .unwrap();
    assert_eq!(user.text, *text);
    assert_eq!(user.is_simulated_msg, Some(true));
    assert_eq!(
        user.simulated_msg_reason,
        Some(pb::SimulatedMsgReason::BackgroundTaskCompletion as i32)
    );
    let metadata = user.simulated_message_metadata.unwrap();
    assert_eq!(
        metadata.title.as_deref(),
        Some("Start Python HTTP server on 9000")
    );
    assert_eq!(metadata.task_id.as_deref(), Some("977679"));
}

#[tokio::test]
async fn goal_creation_persists_active_state_for_client_continuation() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(goal_tool_response(
        "CreateGoal",
        "create-goal-1",
        serde_json::json!({"objective": "keep fixing until the build passes"}),
    ));
    protocol.push(stop_response(
        "goal-progress",
        "The build still fails; investigation remains.",
    ));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store,
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("create-goal-request").await.unwrap();
    let mut start = user_run("keep fixing until the build passes /goal", "goal-message");
    if let Some(pb::agent_client_message::Message::RunRequest(request)) = start.message.as_mut() {
        request.agent_session_id = Some("goal-agent-session".into());
    }
    let (checkpoint, _) = drive_completion(&handle, start).await;
    let goal = checkpoint
        .goal_state
        .clone()
        .expect("CreateGoal must persist an active goal so Cursor schedules continuation");
    assert_eq!(goal.conversation_id, "parent-conversation");
    assert_eq!(goal.objective, "keep fixing until the build passes");
    assert_eq!(goal.status, pb::GoalStatus::Active as i32);
    assert_eq!(goal.agent_session_id.as_deref(), Some("goal-agent-session"));
    uuid::Uuid::parse_str(&goal.goal_id).expect("Cursor only continues goals with UUID identities");
    let requests = protocol.requests();
    assert_eq!(requests.len(), 2);
    assert!(serde_json::to_string(&requests[0].history)
        .unwrap()
        .contains("<goal_command>"));

    // Resume twice from the wire checkpoint. Each continuation must append a
    // distinct runtime event without changing the already delivered history.
    let mut state = checkpoint;
    for count in 1..=2 {
        protocol.push(stop_response(
            &format!("progress-{count}"),
            "Still investigating the failing build.",
        ));
        let handle = registry
            .get_or_create(&format!("goal-follow-up-{count}"))
            .await
            .unwrap();
        let (next, _) = drive_completion(&handle, goal_continuation_run(state)).await;
        let next_goal = next.goal_state.as_ref().unwrap();
        assert_eq!(next_goal.goal_id, goal.goal_id);
        assert_eq!(next_goal.status, pb::GoalStatus::Active as i32);
        assert_eq!(next_goal.continuation_count, count);
        state = next;
    }
    protocol.push(goal_tool_response(
        "UpdateGoal",
        "finish-goal",
        serde_json::json!({"status": "complete"}),
    ));
    protocol.push(stop_response("goal-done", "The build now passes."));
    let handle = registry.get_or_create("goal-complete").await.unwrap();
    let (completed, _) = drive_completion(&handle, goal_continuation_run(state)).await;
    assert_eq!(
        completed.goal_state.as_ref().unwrap().status,
        pb::GoalStatus::Complete as i32
    );
    assert_eq!(completed.goal_state.as_ref().unwrap().continuation_count, 3);
    let requests = protocol.requests();
    assert_eq!(requests.len(), 6);
    for (index, count) in [(2, 0), (3, 1), (4, 2)] {
        assert_eq!(
            requests[index].history.last().unwrap().message_id,
            format!("runtime:goal-continuation:{}:{count}", goal.goal_id)
        );
    }
    for pair in requests.windows(2) {
        // Checkpoint hydration reconstructs internal message IDs. Providers
        // receive roles/content, so those must remain an exact prefix.
        let before = pair[0]
            .history
            .iter()
            .map(|message| (&message.role, &message.content))
            .collect::<Vec<_>>();
        let after = pair[1]
            .history
            .iter()
            .map(|message| (&message.role, &message.content))
            .collect::<Vec<_>>();
        assert!(
            after.starts_with(&before),
            "goal continuation changed the provider history prefix"
        );
        assert_eq!(pair[0].prompt, pair[1].prompt);
    }
}

fn goal_tool_response(name: &str, call_id: &str, arguments: serde_json::Value) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: call_id.into(),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: call_id.into(),
            name: name.into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: arguments.to_string(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]
}

fn goal_continuation_run(state: pb::ConversationStateStructure) -> pb::AgentClientMessage {
    let mut message = user_run("", "unused");
    let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message.as_mut()
    else {
        unreachable!()
    };
    request.action.as_mut().unwrap().action =
        Some(pb::conversation_action::Action::GoalContinuationAction(
            pb::GoalContinuationAction::default(),
        ));
    request.conversation_state = Some(state);
    message
}

#[tokio::test]
async fn goal_updates_persist_pause_and_clear_without_replaying_old_creation() {
    for (status, expected) in [("paused", Some(pb::GoalStatus::Paused)), ("cleared", None)] {
        let (_directory, store) = fixtures::temp_store().await;
        let protocol = fake_protocol::FakeProtocol::default();
        protocol.push(goal_tool_response(
            "CreateGoal",
            "create-goal",
            serde_json::json!({"objective": "fix the build"}),
        ));
        protocol.push(stop_response("progress", "The build still needs work."));
        protocol.push(goal_tool_response(
            "UpdateGoal",
            "update-goal",
            serde_json::json!({"status": status}),
        ));
        protocol.push(stop_response(
            "updated",
            "Updated the goal at your request.",
        ));
        protocol.push(stop_response("ordinary-reply", "Here is the status."));
        let assets = PromptAssets::load(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("prompt/cursor")
                .as_path(),
        )
        .unwrap();
        let registry =
            TransportRegistry::new(store, Arc::new(protocol), PromptCompiler::new(assets));
        let handle = registry.get_or_create("goal-before-update").await.unwrap();
        let (state, _) =
            drive_completion(&handle, user_run("/goal fix the build", "start-goal")).await;
        assert!(state.goal_state.is_some());
        let mut update = user_run(&format!("{status} the goal"), "change-goal");
        if let Some(pb::agent_client_message::Message::RunRequest(request)) =
            update.message.as_mut()
        {
            request.conversation_state = Some(state);
        }
        let handle = registry.get_or_create("goal-update").await.unwrap();
        let (state, _) = drive_completion(&handle, update).await;
        assert_eq!(
            state.goal_state.as_ref().map(|goal| goal.status),
            expected.map(|status| status as i32)
        );
        let mut follow_up = user_run("What is the status?", "after-goal-update");
        if let Some(pb::agent_client_message::Message::RunRequest(request)) =
            follow_up.message.as_mut()
        {
            request.conversation_state = Some(state);
        }
        let handle = registry.get_or_create("after-goal-update").await.unwrap();
        let (state, _) = drive_completion(&handle, follow_up).await;
        assert_eq!(
            state.goal_state.as_ref().map(|goal| goal.status),
            expected.map(|status| status as i32)
        );
    }
}

#[tokio::test]
async fn goal_continuation_starts_a_simulated_turn_and_preserves_goal_state() {
    let (_directory, store) = fixtures::temp_store().await;
    let protocol = fake_protocol::FakeProtocol::default();
    protocol.push(stop_response("model-call", "continuing the goal"));
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    let registry = TransportRegistry::new(
        store.clone(),
        Arc::new(protocol.clone()),
        PromptCompiler::new(assets),
    );
    let handle = registry.get_or_create("goal-request").await.unwrap();
    let goal_state = pb::GoalState {
        conversation_id: "parent-conversation".into(),
        goal_id: "goal-9".into(),
        objective: "find our screen-shot function".into(),
        status: pb::GoalStatus::Active as i32,
        continuation_count: 2,
        ..Default::default()
    };
    let (checkpoint, _blobs) = drive_completion(
        &handle,
        pb::AgentClientMessage {
            message: Some(pb::agent_client_message::Message::RunRequest(
                pb::AgentRunRequest {
                    action: Some(pb::ConversationAction {
                        action: Some(pb::conversation_action::Action::GoalContinuationAction(
                            pb::GoalContinuationAction::default(),
                        )),
                        ..Default::default()
                    }),
                    conversation_id: Some("parent-conversation".into()),
                    requested_model: Some(pb::RequestedModel {
                        model_id: "test-model".into(),
                        ..Default::default()
                    }),
                    conversation_state: Some(pb::ConversationStateStructure {
                        mode: Some(pb::AgentMode::Agent as i32),
                        goal_state: Some(goal_state.clone()),
                        ..Default::default()
                    }),
                    run_id: Some("goal-continuation-run".into()),
                    ..Default::default()
                },
            )),
        },
    )
    .await;

    let requests = protocol.requests();
    assert_eq!(requests.len(), 1);
    let history = serde_json::to_string(&requests[0].history).unwrap();
    assert!(history.contains("find our screen-shot function"));

    let messages = store
        .load_current_messages(&cursor_server::model::ConversationId::new(
            "parent-conversation",
        ))
        .await
        .unwrap();
    assert!(messages.iter().any(|message| {
        message.runtime_event_id.as_deref() == Some("goal-continuation:goal-9:2")
    }));

    // The checkpointed conversation state must keep the client's GoalState so
    // the next continuation still sees an active goal.
    assert_eq!(
        checkpoint.goal_state,
        Some(pb::GoalState {
            continuation_count: 3,
            ..goal_state
        })
    );
}

async fn drive_completion(
    handle: &TransportHandle,
    message: pb::AgentClientMessage,
) -> (pb::ConversationStateStructure, HashMap<Vec<u8>, Vec<u8>>) {
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(message),
        })
        .await
        .unwrap();

    let mut append_seqno = 1;
    let mut blobs = HashMap::new();
    let mut final_checkpoint = None;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                assert_eq!(exec.id, 0);
                assert!(matches!(
                    exec.message,
                    Some(pb::exec_server_message::Message::RequestContextArgs(_))
                ));
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(
                                pb::agent_client_message::Message::ExecClientControlMessage(
                                    pb::ExecClientControlMessage {
                                        message: Some(
                                            pb::exec_client_control_message::Message::StreamClose(
                                                pb::ExecClientStreamClose { id: 0 },
                                            ),
                                        ),
                                    },
                                ),
                            ),
                        }),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: 0,
                                    message: Some(
                                        pb::exec_client_message::Message::RequestContextResult(
                                            pb::RequestContextResult {
                                                result: Some(
                                                    pb::request_context_result::Result::Success(
                                                        pb::RequestContextSuccess {
                                                            request_context: Some(
                                                                pb::RequestContext::default(),
                                                            ),
                                                            ..Default::default()
                                                        },
                                                    ),
                                                ),
                                            },
                                        ),
                                    ),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                if let Some(pb::kv_server_message::Message::SetBlobArgs(set)) = &kv.message {
                    blobs.insert(set.blob_id.clone(), set.blob_data.clone());
                }
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state))
                if state.pending_tool_calls.is_empty() =>
            {
                final_checkpoint = Some(state);
            }
            _ => {}
        }
    }
    (
        final_checkpoint.expect("settled completion checkpoint"),
        blobs,
    )
}

async fn drive_forwarded_completion(
    handle: &TransportHandle,
    message: pb::AgentClientMessage,
) -> Option<pb::ConversationStateStructure> {
    let mut checkpoint = None;
    let mut output = handle.subscribe();
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(message),
        })
        .await
        .unwrap();
    let mut append_seqno = 1;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(payload.as_ref(), b"{}");
            return checkpoint;
        }
        let server = pb::AgentServerMessage::decode(payload).unwrap();
        match server.message {
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                checkpoint = Some(state);
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                assert_eq!(exec.id, 0);
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(
                                pb::agent_client_message::Message::ExecClientControlMessage(
                                    pb::ExecClientControlMessage {
                                        message: Some(
                                            pb::exec_client_control_message::Message::StreamClose(
                                                pb::ExecClientStreamClose { id: 0 },
                                            ),
                                        ),
                                    },
                                ),
                            ),
                        }),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: 0,
                                    message: Some(
                                        pb::exec_client_message::Message::RequestContextResult(
                                            pb::RequestContextResult {
                                                result: Some(
                                                    pb::request_context_result::Result::Success(
                                                        pb::RequestContextSuccess {
                                                            request_context: Some(
                                                                pb::RequestContext::default(),
                                                            ),
                                                            ..Default::default()
                                                        },
                                                    ),
                                                ),
                                            },
                                        ),
                                    ),
                                    ..Default::default()
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                handle
                    .command(TransportCommand::Append {
                        seqno: append_seqno,
                        message: Box::new(kv_ack(kv.id)),
                    })
                    .await
                    .unwrap();
                append_seqno += 1;
            }
            _ => {}
        }
    }
}

fn completion_run(
    child_id: &str,
    run_id: &str,
    conversation_state: pb::ConversationStateStructure,
) -> pb::AgentClientMessage {
    completion_run_with_detail(child_id, run_id, conversation_state, "child result")
}

fn completion_run_with_detail(
    child_id: &str,
    run_id: &str,
    conversation_state: pb::ConversationStateStructure,
    detail: &str,
) -> pb::AgentClientMessage {
    completion_run_for_call(child_id, "task-call", run_id, conversation_state, detail)
}

fn backgrounded(subagents: &[(&str, &str)]) -> pb::ConversationStateStructure {
    pb::ConversationStateStructure {
        mode: Some(pb::AgentMode::Multitask as i32),
        subagent_runs_by_parent_tool_call_id: subagents
            .iter()
            .map(|(child_id, tool_call_id)| {
                (
                    (*tool_call_id).into(),
                    pb::SubagentRunState {
                        parent_tool_call_id: (*tool_call_id).into(),
                        subagent_id: Some((*child_id).into()),
                        status: pb::SubagentRunStatus::Backgrounded as i32,
                        title: Some("Inspect protocol".into()),
                        ..Default::default()
                    },
                )
            })
            .collect(),
        ..Default::default()
    }
}

fn assert_subagent_finished(state: &pb::ConversationStateStructure, tool_call_id: &str) {
    let run = state
        .subagent_runs_by_parent_tool_call_id
        .get(tool_call_id)
        .unwrap_or_else(|| panic!("checkpoint lost subagent {tool_call_id}"));
    assert_eq!(
        run.status,
        pb::SubagentRunStatus::Success as i32,
        "subagent {tool_call_id} still shows as running"
    );
    assert!(run.completed_timestamp_ms.is_some());
    assert_eq!(
        run.completion_reason,
        Some(pb::BackgroundTaskCompletionReason::TaskFinished as i32)
    );
    assert_eq!(run.detail.as_deref(), Some("child result"));
    assert_eq!(run.output_path.as_deref(), Some("/tmp/child.jsonl"));
}

fn completion_run_for_call(
    child_id: &str,
    tool_call_id: &str,
    run_id: &str,
    conversation_state: pb::ConversationStateStructure,
    detail: &str,
) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(
                        pb::conversation_action::Action::BackgroundTaskCompletionAction(
                            pb::BackgroundTaskCompletionAction {
                                completions: vec![pb::BackgroundTaskCompletion {
                                    task_id: child_id.into(),
                                    kind: pb::BackgroundTaskKind::Subagent as i32,
                                    status: pb::BackgroundTaskStatus::Success as i32,
                                    title: "Inspect protocol".into(),
                                    detail: Some(detail.into()),
                                    output_path: Some("/tmp/child.jsonl".into()),
                                    reason: pb::BackgroundTaskCompletionReason::TaskFinished as i32,
                                    subagent_id: Some(child_id.into()),
                                    tool_call_id: Some(tool_call_id.into()),
                                    ..Default::default()
                                }],
                            },
                        ),
                    ),
                    ..Default::default()
                }),
                conversation_id: Some("parent-conversation".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                conversation_state: Some(conversation_state),
                run_id: Some(run_id.into()),
                ..Default::default()
            },
        )),
    }
}

fn shell_completion_run(
    conversation_state: pb::ConversationStateStructure,
) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                action: Some(pb::ConversationAction {
                    action: Some(
                        pb::conversation_action::Action::BackgroundTaskCompletionAction(
                            pb::BackgroundTaskCompletionAction {
                                completions: vec![pb::BackgroundTaskCompletion {
                                    task_id: "977679".into(),
                                    kind: pb::BackgroundTaskKind::Shell as i32,
                                    status: pb::BackgroundTaskStatus::Aborted as i32,
                                    title: "Start Python HTTP server on 9000".into(),
                                    detail: Some("terminated_by_user".into()),
                                    output_path: Some("/tmp/977679.txt".into()),
                                    reason: pb::BackgroundTaskCompletionReason::TaskFinished as i32,
                                    tool_call_id: Some("shell-call".into()),
                                    ..Default::default()
                                }],
                            },
                        ),
                    ),
                    ..Default::default()
                }),
                conversation_id: Some("parent-conversation".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: "test-model".into(),
                    ..Default::default()
                }),
                conversation_state: Some(conversation_state),
                run_id: Some("shell-parent-run".into()),
                ..Default::default()
            },
        )),
    }
}

fn stop_response(model_call_id: &str, text: &str) -> Vec<ModelEvent> {
    vec![
        ModelEvent::Start {
            model_call_id: model_call_id.into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta(text.into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]
}

fn kv_ack(id: u32) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::KvClientMessage(
            pb::KvClientMessage {
                id,
                message: Some(pb::kv_client_message::Message::SetBlobResult(
                    pb::SetBlobResult { error: None },
                )),
            },
        )),
    }
}
