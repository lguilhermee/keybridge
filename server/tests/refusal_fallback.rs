//! Verifies refusal switching through the run engine and outgoing HTTP requests.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use axum::{http::header, routing::post, Json, Router};
use cursor_server::{
    model::{
        ConversationId, ModelConfigInput, ModelLatency, ModelSpec, ModelType, PreparedRun,
        PromptSpec, RefusalFallback, RunAction, RunId, RunKind, OPENAI_RESPONSES_ENDPOINT,
    },
    network::NetworkClients,
    protocol::ProtocolRouter,
    provider::{ProviderRegistry, ProviderRuntime},
    run::{self, RunEngine, RunEvent, RunOutcome},
    store::Store,
};
use serde_json::{json, Value};

fn model_input(base_url: &str, model_id: &str, effort: Option<&str>) -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 0,
        display_name: model_id.into(),
        group_name: None,
        model_type: ModelType::OpenAi,
        base_url: base_url.into(),
        use_full_url: false,
        api_key: "test-key".into(),
        tooltip_data: "test".into(),
        model_id: model_id.into(),
        reasoning_effort: effort.map(str::to_owned),
        openai_endpoint: OPENAI_RESPONSES_ENDPOINT.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: json!({}),
        custom_headers_enabled: false,
        custom_headers: json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: json!({}),
        context_window_tokens: Some(128_000),
        max_completion_tokens: Some(4_096),
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

async fn run(store: &Store, protocol: Arc<ProtocolRouter>, model: ModelSpec, index: usize) {
    let conversation_id = ConversationId::new("refusal-settings");
    let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let prepared = PreparedRun {
        run_id: RunId::new(format!("run-{index}")),
        cursor_request_id: None,
        conversation_id,
        kind: RunKind::Root,
        model,
        prompt: PromptSpec {
            instructions: "Answer the user.".into(),
            tools: Vec::new(),
        },
        initial_messages: vec![fixtures::user(&format!("user-{index}"), "hello")],
        action: RunAction::Start,
        base_checkpoint_id,
    };
    let (port, mut session, handle) = run::channel(prepared.run_id.clone(), 32);
    let engine = RunEngine::new(store.clone(), protocol);
    let task = tokio::spawn(async move { engine.run(prepared, port, handle.cancellation()).await });
    let mut text = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), session.events.recv())
            .await
            .unwrap()
            .unwrap();
        match event {
            RunEvent::TextDelta(delta) => text.push_str(&delta),
            RunEvent::MessagesCommitted(committed) => committed.barrier.complete(Ok(())),
            RunEvent::Ended(outcome) => {
                assert_eq!(outcome, RunOutcome::Completed);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(task.await.unwrap(), RunOutcome::Completed);
    assert_eq!(text, "Answer from refusal model.");
}

#[tokio::test]
async fn refusal_uses_saved_settings_and_next_run_keeps_client_settings() {
    let late_refusal = format!(
        "{}\n\nQuoted example: \"I cannot assist with that.\"\n\n```text\nI won't help with that.\n```\n\nI won't be able to help debug this one.",
        "Some background about the request. ".repeat(100)
    );
    for saved_effort in [Some("high"), None] {
        verify_refusal(saved_effort, None).await;
        verify_refusal(saved_effort, Some(&late_refusal)).await;
    }
}

#[tokio::test]
async fn reported_refusals_switch_with_the_refusal_models_own_settings() {
    for reply in [
        include_str!("fixtures/refusals/stopping-here.md"),
        include_str!("fixtures/refusals/nao-vou-implementar.md"),
        include_str!("fixtures/refusals/wont-implement.md"),
        include_str!("fixtures/refusals/wont-hunt-for-exploit.md"),
        include_str!("fixtures/refusals/cant-continue-with.md"),
    ] {
        for saved_effort in [Some("high"), None] {
            verify_refusal(saved_effort, Some(reply)).await;
        }
    }
}

#[tokio::test]
async fn garak_discovered_refusals_switch_with_the_refusal_models_own_settings() {
    for reply in [
        "I won't lay out a way to do that.",
        "I can't add that. I can help with a legitimate alternative.",
        "I can't rename or disguise the tool to avoid detection. I left the project unchanged.",
        "I'm not going to adopt that persona.",
    ] {
        for saved_effort in [Some("high"), None] {
            verify_refusal(saved_effort, Some(reply)).await;
        }
    }
}

async fn verify_refusal(saved_effort: Option<&str>, reply: Option<&str>) {
    let reply = reply.map(str::to_owned);
    let (_directory, store) = fixtures::temp_store().await;
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let upstream = Router::new().route(
            "/v1/responses",
            post(move |Json(body): Json<Value>| {
                let sent = sent.clone();
                let reply = reply.clone();
                async move {
                    let refuses = body["model"] == "original";
                    sent.send(body).unwrap();
                    let content = if let (true, Some(text)) = (refuses, reply) {
                        json!({"type":"output_text","text":text})
                    } else if refuses {
                        json!({"type":"refusal","refusal":"I cannot help with that."})
                    } else {
                        json!({"type":"output_text","text":"Answer from refusal model."})
                    };
                    let item = json!({"type":"response.output_item.done","output_index":0,
                        "item":{"type":"message","role":"assistant","content":[content]}});
                    let response = json!({"type":"response.completed","response":{
                        "id":"response-test","status":"completed",
                        "output":[item["item"]]
                    }});
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        format!("event: response.output_item.done\ndata: {item}\n\nevent: response.completed\ndata: {response}\n\n"),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let original = store
        .create_model(&model_input(&base_url, "original", Some("high")))
        .await
        .unwrap();
    let refusal = store
        .create_model(&model_input(&base_url, "refusal", saved_effort))
        .await
        .unwrap();
    store
        .replace_refusal_fallbacks(&[RefusalFallback {
            model_id: original.model_hash.clone(),
            fallback_model_id: refusal.model_hash,
        }])
        .await
        .unwrap();
    let clients = NetworkClients::new(store.clone());
    let headroom = cursor_server::headroom::HeadroomRuntime::new(store.clone(), clients.clone());
    let providers = ProviderRegistry::managed(
        store.clone(),
        ProviderRuntime::managed().unwrap(),
        "0.1.0".into(),
        headroom.clone(),
    )
    .unwrap();
    let protocol = Arc::new(ProtocolRouter::new(
        store.clone(),
        providers,
        clients,
        headroom,
        Duration::from_secs(5),
        Duration::from_secs(5),
    ));
    for (index, effort) in ["medium", "max"].into_iter().enumerate() {
        let mut selected = ModelSpec::new(&original.model_hash);
        selected.reasoning.enabled = true;
        selected.reasoning.effort = Some(effort.into());
        selected.latency = ModelLatency::Fast;
        selected.max_output_tokens = Some(32_000);
        selected.context_window_tokens = Some(1_000_000);
        run(&store, protocol.clone(), selected, index).await;

        let original = received.try_recv().unwrap();
        let refusal = received.try_recv().unwrap();
        assert_eq!(original["model"], "original");
        assert_eq!(original["reasoning"]["effort"], effort);
        assert_eq!(original["service_tier"], "priority");
        assert_eq!(original["max_output_tokens"], 32_000);
        assert_eq!(refusal["model"], "refusal");
        assert_eq!(refusal["reasoning"]["effort"], json!(saved_effort));
        assert_eq!(refusal["max_output_tokens"], 4_096);
        assert!(refusal.get("service_tier").is_none());
    }
    server.abort();
}
