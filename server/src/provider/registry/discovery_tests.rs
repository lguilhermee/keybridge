//! Exercises discovery through the real provider worker and resource persistence.
use super::*;
use crate::provider::state::{ResourceState, ResourceStateInput};

#[tokio::test]
#[ignore = "requires DENO_BIN pointing to a Deno executable"]
async fn discovery_persists_refreshes_and_merges_usable_accounts() {
    let executable = std::path::PathBuf::from(std::env::var_os("DENO_BIN").expect("set DENO_BIN"));
    let directory = tempfile::tempdir().unwrap();
    let providers = directory.path().join("providers");
    let provider = providers.join("fixture");
    std::fs::create_dir_all(&provider).unwrap();
    std::fs::write(provider.join("icon.svg"), "<svg/>").unwrap();
    std::fs::write(
        provider.join("provider.json"),
        r#"{"apiVersion":1,"id":"test.discovery","name":"Discovery","version":"1.0.0","icon":"icon.svg","entry":"index.ts"}"#,
    ).unwrap();
    std::fs::write(
        provider.join("index.ts"),
        r#"
import { defineProvider } from "cursor-byok:provider";
defineProvider({
  resources: [{
    type: "account", displayName: "Account", present: () => ({ displayName: "Account" }),
    refresh: async (resource) => {
      const data = resource.privateData;
      if (data.mode === "transient") throw new Error("Usage endpoint unavailable");
      if (data.mode === "invalid") return { state: { status: "invalid" } };
      if (data.mode === "cooling") return { state: { status: "cooling" } };
      return { privateData: { ...data, token: "fresh" }, state: { status: "ready" } };
    },
  }],
  channels: [{
    id: "chat", displayName: "Chat", brand: "test", resourceType: "account",
    invoke: async () => ({ status: "completed" }),
    models: { list: async ({ resource }) => {
      const data = resource.privateData;
      if (data.mode === "refresh" && data.token !== "fresh") throw new Error("Stale credentials");
      if (data.mode === "malformed") return [{ id: "leaked-partial", displayName: "Partial" }, {}];
      return data.models.map(id => ({ id, displayName: id }));
    } },
  }],
});
"#,
    )
    .unwrap();
    let catalog = ProviderCatalog::for_test(&providers).unwrap();
    let definition = catalog
        .loader()
        .load(&executable, &provider, &provider.join("index.ts"))
        .await
        .unwrap();
    let entry = ProviderEntry {
        directory: provider.clone(),
        entry: provider.join("index.ts"),
        manifest: serde_json::from_slice(&std::fs::read(provider.join("provider.json")).unwrap())
            .unwrap(),
        definition,
        icon: String::new(),
        source_hash: "fixture".into(),
    };
    let store = Store::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let state = ProviderStateStore::new(
        ProviderDataStore::for_test(directory.path().join("data")).unwrap(),
    );
    let registry = ProviderRegistry {
        inner: Arc::new(RegistryInner {
            runtime: ProviderRuntime::for_test(directory.path().join("runtime")).unwrap(),
            catalog,
            state: state.clone(),
            headroom: crate::headroom::HeadroomRuntime::new(
                store.clone(),
                crate::network::NetworkClients::new(store.clone()),
            ),
            store,
            entries: RwLock::new(Some(vec![entry.clone()])),
            workers: Mutex::new(HashMap::new()),
            oauth_sessions: Mutex::new(HashMap::new()),
            catalog_refreshes: Mutex::new(HashSet::new()),
        }),
    };
    let drafts = [
        ("refresh", vec!["shared", "only-fresh"]),
        ("transient", vec!["shared", "only-transient"]),
        ("invalid", vec!["invalid-leak"]),
        ("malformed", vec![]),
    ]
    .into_iter()
    .map(|(mode, models)| ResourceDraft {
        key: mode.into(),
        private_data: serde_json::json!({ "mode": mode, "token": "old", "models": models }),
        state: None,
    })
    .collect();
    state
        .upsert_resources("test.discovery", "account", drafts)
        .await
        .unwrap();
    let channel = &entry.definition.channels[0];
    assert_eq!(
        registry
            .sync_channel_models(&entry, &executable, channel)
            .await
            .unwrap(),
        3
    );
    let models = state.models("test.discovery", "chat").await.unwrap();
    let mut ids = models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(ids, ["only-fresh", "only-transient", "shared"]);
    let shared = models.iter().find(|model| model.id == "shared").unwrap();
    assert_eq!(shared.resource_models.len(), 2);
    let fresh_only = models
        .iter()
        .find(|model| model.id == "only-fresh")
        .unwrap();
    assert_eq!(fresh_only.resource_models.len(), 1);
    let records = state.resources("test.discovery", "account").await.unwrap();
    let fresh = records
        .iter()
        .find(|record| record.key == "refresh")
        .unwrap();
    assert_eq!(fresh.private_data["token"], "fresh");
    let invalid = records
        .iter()
        .find(|record| record.key == "invalid")
        .unwrap();
    assert!(matches!(invalid.state, ResourceState::Invalid { .. }));
    for record in records {
        state
            .remove_resource("test.discovery", "account", &record.id)
            .await
            .unwrap();
    }
    state
        .upsert_resources(
            "test.discovery",
            "account",
            vec![ResourceDraft {
                key: "cooling".into(),
                private_data: serde_json::json!({ "mode": "cooling", "models": ["cooldown"] }),
                state: Some(ResourceStateInput::Cooling {
                    retry_at_ms: None,
                    message: None,
                }),
            }],
        )
        .await
        .unwrap();
    assert_eq!(
        registry
            .sync_channel_models(&entry, &executable, channel)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        state.models("test.discovery", "chat").await.unwrap()[0].id,
        "cooldown"
    );
    registry.remove("test.discovery").await.unwrap();
    drop(registry);
    drop(state);
}
