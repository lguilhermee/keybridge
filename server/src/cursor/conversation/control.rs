//! Distinguishes explicit user turns from automatic continuation requests.
use crate::cursor::protocol::proto::agent::v1 as pb;

pub(super) fn user_message(request: &pb::AgentRunRequest) -> Option<&pb::UserMessage> {
    match request.action.as_ref()?.action.as_ref()? {
        pb::conversation_action::Action::UserMessageAction(action) => action
            .user_message
            .as_ref()
            .filter(|user| is_explicit_user(user)),
        _ => None,
    }
}

pub(super) fn is_explicit_user(user: &pb::UserMessage) -> bool {
    // The native desktop sender uses UserMessageAction. A remotely delivered
    // request must not undo a racing Stop on either transport input path.
    user.is_simulated_msg != Some(true) && !user.text.starts_with("<nuia_discord_request>\n")
}

pub(super) fn pauses_conversation(user: &pb::UserMessage) -> bool {
    let text = user.text.trim().to_ascii_lowercase();
    let mut words = text.split_whitespace();
    let mut command = words.next().unwrap_or_default();
    if matches!(command, "please" | "just") {
        command = words.next().unwrap_or_default();
    }
    matches!(
        command
            .trim_start_matches('/')
            .trim_end_matches([',', '.', '!', ':']),
        "stop" | "pause"
    )
}

pub(super) fn background_completion(
    request: &pb::AgentRunRequest,
) -> Option<&pb::BackgroundTaskCompletionAction> {
    match request.action.as_ref()?.action.as_ref()? {
        pb::conversation_action::Action::BackgroundTaskCompletionAction(action) => Some(action),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discord_delivery_cannot_clear_an_explicit_pause() {
        let mut request = pb::AgentRunRequest {
            action: Some(pb::ConversationAction {
                action: Some(pb::conversation_action::Action::UserMessageAction(
                    pb::UserMessageAction {
                        user_message: Some(pb::UserMessage {
                            text: "<nuia_discord_request>\n{\"request\":\"continue\"}\n</nuia_discord_request>".into(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(user_message(&request).is_none());

        let Some(pb::conversation_action::Action::UserMessageAction(action)) = request
            .action
            .as_mut()
            .and_then(|action| action.action.as_mut())
        else {
            unreachable!();
        };
        action.user_message.as_mut().unwrap().text = "continue".into();
        assert!(user_message(&request).is_some());
    }

    #[test]
    fn stop_instructions_remain_stop_when_the_user_adds_emphasis() {
        for text in [
            "stop",
            "STOP!!",
            "/pause",
            "stop, seriously",
            "stop again",
            "please stop now",
            "just pause all tasks",
        ] {
            assert!(
                pauses_conversation(&pb::UserMessage {
                    text: text.into(),
                    ..Default::default()
                }),
                "{text}"
            );
        }
        for text in [
            "continue",
            "do not stop",
            "don't stop",
            "explain stop tokens",
            "stopping distance",
        ] {
            assert!(
                !pauses_conversation(&pb::UserMessage {
                    text: text.into(),
                    ..Default::default()
                }),
                "{text}"
            );
        }
    }
}
