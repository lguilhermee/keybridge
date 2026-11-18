#[path = "support/fixtures.rs"]
mod fixtures;

use std::{fs, path::Path};

use cursor_server::{
    headroom::HeadroomRuntime,
    local_app::ClaudeCodeHarness,
    model::{ModelConfigInput, ModelType, OPENAI_CHAT_ENDPOINT},
    network::NetworkClients,
    provider::{ProviderRegistry, ProviderRuntime},
    store::Store,
};
use serde_json::{json, Value};

fn model_input() -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 0,
        display_name: "Example".into(),
        group_name: Some("work".into()),
        model_type: ModelType::OpenAi,
        base_url: "https://example.com/v1".into(),
        use_full_url: false,
        api_key: "upstream".into(),
        tooltip_data: "test".into(),
        model_id: "qwen/model".into(),
        reasoning_effort: None,
        openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: json!({}),
        custom_headers_enabled: false,
        custom_headers: json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: json!({}),
        context_window_tokens: None,
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

fn harness(store: &Store, path: &Path) -> ClaudeCodeHarness {
    let providers = ProviderRegistry::managed(
        store.clone(),
        ProviderRuntime::managed().unwrap(),
        "0.1.0".into(),
        HeadroomRuntime::new(store.clone(), NetworkClients::new(store.clone())),
    )
    .unwrap();
    ClaudeCodeHarness::new(store.clone(), providers, path.to_owned())
}

fn read(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn connects_and_restores_claude_code_settings_across_server_lifecycle() {
    let (directory, store) = fixtures::temp_store().await;
    store.create_model(&model_input()).await.unwrap();
    let path = directory.path().join("claude").join("settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = json!({
        "model":"claude-sonnet-4-6",
        "permissions":{"allow":["Bash(git status:*)"]},
        "env":{
            "ANTHROPIC_BASE_URL":"https://previous.example",
            "ANTHROPIC_API_KEY":"previous-key",
            "OTHER_VAR":"keep"
        }
    });
    fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();
    let harness = harness(&store, &path);
    harness.set_backend_addr("127.0.0.1:4321".parse().unwrap());
    let status = serde_json::to_value(harness.set_enabled(true).await.unwrap()).unwrap();
    assert_eq!(status["integration"], "enabled");
    assert_eq!(status["model"], "work/qwen/model");
    let connected = read(&path);
    assert_eq!(connected["model"], "work/qwen/model");
    assert_eq!(
        connected["env"]["ANTHROPIC_BASE_URL"],
        "http://127.0.0.1:4321/byok"
    );
    assert_eq!(
        connected["env"]["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"],
        "1"
    );
    assert!(connected["env"].get("ANTHROPIC_API_KEY").is_none());
    assert_eq!(connected["env"]["OTHER_VAR"], "keep");
    assert_eq!(connected["permissions"], original["permissions"]);
    let api = store.external_api_settings().await.unwrap();
    assert_eq!(connected["env"]["ANTHROPIC_AUTH_TOKEN"], api.api_key);

    harness.release().await.unwrap();
    assert_eq!(read(&path), original);
    assert_eq!(
        serde_json::to_value(harness.status().await.unwrap()).unwrap()["integration"],
        "degraded"
    );

    harness.set_backend_addr("127.0.0.1:5000".parse().unwrap());
    harness.refresh().await;
    assert_eq!(
        read(&path)["env"]["ANTHROPIC_BASE_URL"],
        "http://127.0.0.1:5000/byok"
    );
    harness.set_enabled(false).await.unwrap();
    assert_eq!(read(&path), original);
}

#[tokio::test]
async fn malformed_settings_are_not_overwritten() {
    let (directory, store) = fixtures::temp_store().await;
    store.create_model(&model_input()).await.unwrap();
    let path = directory.path().join("claude").join("settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{ invalid").unwrap();
    let harness = harness(&store, &path);
    harness.set_backend_addr("127.0.0.1:4321".parse().unwrap());
    assert!(harness.set_enabled(true).await.is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{ invalid");
}
