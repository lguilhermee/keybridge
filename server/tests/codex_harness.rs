#[path = "support/fixtures.rs"]
mod fixtures;

use std::{fs, path::Path};

use cursor_server::{
    headroom::HeadroomRuntime,
    local_app::CodexHarness,
    model::{ModelConfigInput, ModelType, OPENAI_CHAT_ENDPOINT},
    network::NetworkClients,
    provider::{ProviderRegistry, ProviderRuntime},
    store::Store,
};
use serde_json::{json, Value};

const USER_CONFIG: &str =
    "# mine\nmodel = \"gpt-5.5\"\n\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n";

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
        context_window_tokens: Some(128_000),
        max_completion_tokens: None,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

/// A harness whose Codex home and catalog live inside the test's temporary directory.
fn harness(store: &Store, directory: &Path) -> CodexHarness {
    let providers = ProviderRegistry::managed(
        store.clone(),
        ProviderRuntime::managed().unwrap(),
        "0.1.0".into(),
        HeadroomRuntime::new(store.clone(), NetworkClients::new(store.clone())),
    )
    .unwrap();
    CodexHarness::new(
        store.clone(),
        providers,
        directory.join("codex-home"),
        directory.join("keybridge").join("models.json"),
    )
}

async fn state(harness: &CodexHarness) -> Value {
    serde_json::to_value(harness.status().await.unwrap()).unwrap()
}

#[tokio::test]
async fn connecting_points_codex_at_keybridge_and_every_exit_restores_the_user_config() {
    let (directory, store) = fixtures::temp_store().await;
    store.create_model(&model_input()).await.unwrap();
    let config_path = directory.path().join("codex-home").join("config.toml");
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    fs::write(&config_path, USER_CONFIG).unwrap();
    let harness = harness(&store, directory.path());
    assert_eq!(state(&harness).await["integration"], "disabled");
    assert_eq!(fs::read_to_string(&config_path).unwrap(), USER_CONFIG);

    // Connecting turns the external API on and selects the first configured model.
    harness.set_backend_addr("127.0.0.1:4321".parse().unwrap());
    let status = serde_json::to_value(harness.set_enabled(true).await.unwrap()).unwrap();
    assert_eq!(status["integration"], "enabled", "{status}");
    assert_eq!(status["model"], "work/qwen/model");
    let api = store.external_api_settings().await.unwrap();
    assert!(api.enabled && !api.api_key.is_empty());
    let connected = fs::read_to_string(&config_path).unwrap();
    for expected in [
        "# mine",
        "model = \"work/qwen/model\"",
        "model_provider = \"keybridge\"",
        "[model_providers.keybridge]",
        "base_url = \"http://127.0.0.1:4321/byok/v1\"",
        "wire_api = \"responses\"",
        "[mcp_servers.docs]",
    ] {
        assert!(connected.contains(expected), "{expected}: {connected}");
    }
    assert!(connected.contains(&api.api_key), "{connected}");
    let catalog: Value = serde_json::from_str(
        &fs::read_to_string(directory.path().join("keybridge").join("models.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(catalog["models"][0]["slug"], "work/qwen/model");
    assert_eq!(catalog["models"][0]["context_window"], 128_000);

    // Stopping the server hands Codex back; the connection itself stays on.
    harness.release().await.unwrap();
    assert_eq!(fs::read_to_string(&config_path).unwrap(), USER_CONFIG);
    assert_eq!(state(&harness).await["integration"], "degraded");

    // The next start reconnects on whatever port the server got.
    harness.set_backend_addr("127.0.0.1:5000".parse().unwrap());
    harness.refresh().await;
    let reconnected = fs::read_to_string(&config_path).unwrap();
    assert!(
        reconnected.contains("http://127.0.0.1:5000/byok/v1"),
        "{reconnected}"
    );
    assert_eq!(state(&harness).await["integration"], "enabled");

    // Without a model Codex would refuse the empty catalog, so it gets its own config back.
    let model_hash = store.models().await.unwrap()[0].model_hash.clone();
    store
        .delete_models(std::slice::from_ref(&model_hash))
        .await
        .unwrap();
    harness.refresh().await;
    if state(&harness).await["configured_models"] == 0 {
        assert_eq!(fs::read_to_string(&config_path).unwrap(), USER_CONFIG);
    }

    let status = serde_json::to_value(harness.set_enabled(false).await.unwrap()).unwrap();
    assert_eq!(status["integration"], "disabled");
    assert_eq!(fs::read_to_string(&config_path).unwrap(), USER_CONFIG);
}

#[tokio::test]
async fn a_disabled_connection_never_touches_the_codex_home() {
    let (directory, store) = fixtures::temp_store().await;
    store.create_model(&model_input()).await.unwrap();
    let harness = harness(&store, directory.path());
    harness.set_backend_addr("127.0.0.1:4321".parse().unwrap());
    harness.refresh().await;
    harness.release().await.unwrap();
    let status = state(&harness).await;
    assert_eq!(status["integration"], "disabled");
    assert_eq!(status["installed"], false);
    assert!(!directory.path().join("codex-home").exists());
    assert!(!directory.path().join("keybridge").exists());
}
