//! Owns core-side persistence of provider resources and model catalogs.
use serde::{Deserialize, Serialize};

use super::data::ProviderDataStore;
use crate::{Error, Result};

/// Resource runtime state understood by the core; providers can only change it via draft/patch/report.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResourceState {
    Ready,
    Cooling {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_at_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Invalid {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl ResourceState {
    /// Automatically returns to usable once the cooldown expires.
    pub fn is_ready(&self, now_ms: i64) -> bool {
        match self {
            Self::Ready => true,
            Self::Cooling { retry_at_ms, .. } => retry_at_ms.is_some_and(|at| at <= now_ms),
            Self::Invalid { .. } => false,
        }
    }
}

/// One provider resource persisted by the core. `private_data` is only returned to the provider.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResourceRecord {
    pub id: String,
    pub key: String,
    pub private_data: serde_json::Value,
    pub state: ResourceState,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ResourceRecord {
    /// The snapshot shape handed to the provider (the SDK's ResourceSnapshot).
    pub fn snapshot(&self, resource_type: &str) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "type": resource_type,
            "key": self.key,
            "privateData": self.private_data,
            "state": state_json(&self.state),
        })
    }
}

fn state_json(state: &ResourceState) -> serde_json::Value {
    match state {
        ResourceState::Ready => serde_json::json!({ "status": "ready" }),
        ResourceState::Cooling {
            retry_at_ms,
            message,
        } => serde_json::json!({
            "status": "cooling",
            "retryAtMs": retry_at_ms,
            "message": message,
        }),
        ResourceState::Invalid { message } => serde_json::json!({
            "status": "invalid",
            "message": message,
        }),
    }
}

/// A new resource returned by the provider (the SDK's ResourceDraft).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDraft {
    pub key: String,
    pub private_data: serde_json::Value,
    #[serde(default)]
    pub state: Option<ResourceStateInput>,
}

/// A partial update for one resource from the provider (the SDK's ResourcePatch).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePatch {
    #[serde(default)]
    pub private_data: Option<serde_json::Value>,
    #[serde(default)]
    pub state: Option<ResourceStateInput>,
}

/// SDK-side camelCase state input converted to the core storage shape.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ResourceStateInput {
    Ready,
    Cooling {
        #[serde(default, rename = "retryAtMs")]
        retry_at_ms: Option<i64>,
        #[serde(default)]
        message: Option<String>,
    },
    Invalid {
        #[serde(default)]
        message: Option<String>,
    },
}

impl From<ResourceStateInput> for ResourceState {
    fn from(input: ResourceStateInput) -> Self {
        match input {
            ResourceStateInput::Ready => Self::Ready,
            ResourceStateInput::Cooling {
                retry_at_ms,
                message,
            } => Self::Cooling {
                retry_at_ms,
                message,
            },
            ResourceStateInput::Invalid { message } => Self::Invalid { message },
        }
    }
}

/// One model discovered by the provider (the SDK's ModelDefinition), which the core swaps wholesale into the catalog.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StoredModel {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    /// Total prompt window in tokens (`contextWindow` on the wire); absent when unknown.
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub images: bool,
    #[serde(default)]
    pub options: ModelOptions,
    #[serde(default = "default_model_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub private_data: serde_json::Value,
}

fn default_model_enabled() -> bool {
    true
}

/// Picker settings a provider model declares (the SDK's ModelOptions); the channel maps the
/// chosen values onto upstream model IDs or request fields.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelOptions {
    /// Effort levels in ascending order; empty means no Effort setting.
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub fast: bool,
}

impl ModelOptions {
    fn from_definition(value: Option<&serde_json::Value>) -> Result<Self> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(Self::default());
        };
        let raw: Self = serde_json::from_value(value.clone())
            .map_err(|error| Error::Protocol(format!("invalid provider model options: {error}")))?;
        let mut efforts = Vec::with_capacity(raw.efforts.len());
        for effort in raw.efforts {
            let effort = effort.trim().to_ascii_lowercase();
            if !effort.is_empty() && !efforts.contains(&effort) {
                efforts.push(effort);
            }
        }
        let default_effort = raw
            .default_effort
            .map(|effort| effort.trim().to_ascii_lowercase())
            .filter(|effort| efforts.contains(effort));
        Ok(Self {
            efforts,
            default_effort,
            fast: raw.fast,
        })
    }
}

impl StoredModel {
    pub fn from_definition(value: &serde_json::Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| Error::Protocol("provider model definition must be an object".into()))?;
        let id = object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| Error::Protocol("provider model definition requires id".into()))?;
        let display_name = object
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| {
                Error::Protocol("provider model definition requires displayName".into())
            })?;
        let capabilities = object
            .get("capabilities")
            .and_then(|value| value.as_object());
        let capability = |name: &str| {
            capabilities
                .and_then(|value| value.get(name))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        Ok(Self {
            id: id.to_owned(),
            display_name: display_name.to_owned(),
            description: object
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            max_output_tokens: object
                .get("maxOutputTokens")
                .and_then(serde_json::Value::as_u64),
            context_window: object
                .get("contextWindow")
                .and_then(serde_json::Value::as_u64),
            images: capability("images"),
            options: ModelOptions::from_definition(object.get("options"))?,
            enabled: true,
            private_data: object
                .get("privateData")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        })
    }

    /// The model snapshot handed to the provider (the SDK's ModelSnapshot).
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "displayName": self.display_name,
            "description": self.description,
            "maxOutputTokens": self.max_output_tokens,
            "contextWindow": self.context_window,
            "capabilities": { "images": self.images },
            "options": self.options,
            "privateData": self.private_data,
        })
    }
}

/// Core storage for resources and the model catalog, built on top of provider-private JSON files.
#[derive(Clone)]
pub struct ProviderStateStore {
    data: ProviderDataStore,
}

pub struct UpsertOutcome {
    pub added: usize,
    pub updated: usize,
}

impl ProviderStateStore {
    pub fn new(data: ProviderDataStore) -> Self {
        Self { data }
    }

    pub async fn resources(
        &self,
        provider_id: &str,
        resource_type: &str,
    ) -> Result<Vec<ResourceRecord>> {
        let value = self
            .data
            .read(provider_id, &resource_key(resource_type))
            .await?;
        if value.is_null() {
            return Ok(Vec::new());
        }
        Ok(serde_json::from_value(value)?)
    }

    pub async fn upsert_resources(
        &self,
        provider_id: &str,
        resource_type: &str,
        drafts: Vec<ResourceDraft>,
    ) -> Result<UpsertOutcome> {
        let mut records = self.resources(provider_id, resource_type).await?;
        let now = now_ms();
        let mut outcome = UpsertOutcome {
            added: 0,
            updated: 0,
        };
        for draft in drafts {
            if draft.key.trim().is_empty() {
                return Err(Error::Protocol(
                    "provider resource draft requires key".into(),
                ));
            }
            let state = draft
                .state
                .map_or(ResourceState::Ready, ResourceState::from);
            match records.iter_mut().find(|record| record.key == draft.key) {
                Some(existing) => {
                    existing.private_data = draft.private_data;
                    existing.state = state;
                    existing.updated_at_ms = now;
                    outcome.updated += 1;
                }
                None => {
                    records.push(ResourceRecord {
                        id: uuid::Uuid::new_v4().to_string(),
                        key: draft.key,
                        private_data: draft.private_data,
                        state,
                        created_at_ms: now,
                        updated_at_ms: now,
                    });
                    outcome.added += 1;
                }
            }
        }
        self.save_resources(provider_id, resource_type, &records)
            .await?;
        Ok(outcome)
    }

    pub async fn apply_patch(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
        patch: ResourcePatch,
    ) -> Result<()> {
        let mut records = self.resources(provider_id, resource_type).await?;
        let record = records
            .iter_mut()
            .find(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider resource {resource_id}")))?;
        if let Some(private_data) = patch.private_data {
            record.private_data = private_data;
        }
        if let Some(state) = patch.state {
            record.state = state.into();
        }
        record.updated_at_ms = now_ms();
        self.save_resources(provider_id, resource_type, &records)
            .await
    }

    pub async fn remove_resource(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<ResourceRecord> {
        let mut records = self.resources(provider_id, resource_type).await?;
        let index = records
            .iter()
            .position(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider resource {resource_id}")))?;
        let removed = records.remove(index);
        self.save_resources(provider_id, resource_type, &records)
            .await?;
        Ok(removed)
    }

    pub async fn models(&self, provider_id: &str, channel_id: &str) -> Result<Vec<StoredModel>> {
        let value = self.data.read(provider_id, &model_key(channel_id)).await?;
        if value.is_null() {
            return Ok(Vec::new());
        }
        Ok(serde_json::from_value(value)?)
    }

    pub async fn replace_models(
        &self,
        provider_id: &str,
        channel_id: &str,
        models: &[StoredModel],
    ) -> Result<()> {
        let previous = self.models(provider_id, channel_id).await?;
        let models = models
            .iter()
            .cloned()
            .map(|mut model| {
                if let Some(old) = previous.iter().find(|old| old.id == model.id) {
                    model.enabled = old.enabled;
                }
                model
            })
            .collect::<Vec<_>>();
        self.data
            .update(
                provider_id,
                &model_key(channel_id),
                &serde_json::to_value(models)?,
            )
            .await
    }

    pub async fn set_model_enabled(
        &self,
        provider_id: &str,
        channel_id: &str,
        model_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let mut models = self.models(provider_id, channel_id).await?;
        let model = models
            .iter_mut()
            .find(|model| model.id == model_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider model {model_id}")))?;
        model.enabled = enabled;
        self.data
            .update(
                provider_id,
                &model_key(channel_id),
                &serde_json::to_value(models)?,
            )
            .await
    }

    pub async fn clear(&self, provider_id: &str) -> Result<()> {
        self.data.clear(provider_id).await
    }

    async fn save_resources(
        &self,
        provider_id: &str,
        resource_type: &str,
        records: &[ResourceRecord],
    ) -> Result<()> {
        self.data
            .update(
                provider_id,
                &resource_key(resource_type),
                &serde_json::to_value(records)?,
            )
            .await
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn resource_key(resource_type: &str) -> String {
    format!("resources-{resource_type}")
}

fn model_key(channel_id: &str) -> String {
    format!("models-{channel_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ProviderStateStore) {
        let root = tempfile::tempdir().unwrap();
        let data = ProviderDataStore::for_test(root.path().join("data")).unwrap();
        (root, ProviderStateStore::new(data))
    }

    #[tokio::test]
    async fn upserts_resources_by_key_and_applies_patches() {
        let (_root, store) = store();
        let outcome = store
            .upsert_resources(
                "dev.example",
                "account",
                vec![ResourceDraft {
                    key: "acct-1".into(),
                    private_data: serde_json::json!({"token":"one"}),
                    state: None,
                }],
            )
            .await
            .unwrap();
        assert_eq!(outcome.added, 1);
        let outcome = store
            .upsert_resources(
                "dev.example",
                "account",
                vec![ResourceDraft {
                    key: "acct-1".into(),
                    private_data: serde_json::json!({"token":"two"}),
                    state: None,
                }],
            )
            .await
            .unwrap();
        assert_eq!(outcome.updated, 1);
        let records = store.resources("dev.example", "account").await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].private_data["token"], "two");

        store
            .apply_patch(
                "dev.example",
                "account",
                &records[0].id,
                ResourcePatch {
                    private_data: None,
                    state: Some(ResourceStateInput::Cooling {
                        retry_at_ms: Some(200),
                        message: None,
                    }),
                },
            )
            .await
            .unwrap();
        let records = store.resources("dev.example", "account").await.unwrap();
        assert!(!records[0].state.is_ready(100));
        assert!(records[0].state.is_ready(300), "cooling expires over time");
    }

    #[tokio::test]
    async fn replaces_model_catalogs() {
        let (_root, store) = store();
        let model = StoredModel::from_definition(&serde_json::json!({
            "id": "gpt-test",
            "displayName": "GPT Test",
            "capabilities": {"images": true},
            "privateData": {"reasoningEfforts": ["low"]},
        }))
        .unwrap();
        store
            .replace_models("dev.example", "codex", &[model])
            .await
            .unwrap();
        let models = store.models("dev.example", "codex").await.unwrap();
        assert_eq!(models.len(), 1);
        assert!(models[0].images);
        assert_eq!(models[0].private_data["reasoningEfforts"][0], "low");
    }

    #[test]
    fn model_definitions_carry_context_window_through_the_snapshot() {
        let model = StoredModel::from_definition(&serde_json::json!({
            "id": "claude-test",
            "displayName": "Claude Test",
            "contextWindow": 200_000,
        }))
        .unwrap();
        assert_eq!(model.context_window, Some(200_000));
        assert_eq!(
            model.snapshot()["contextWindow"],
            serde_json::json!(200_000)
        );

        let unknown = StoredModel::from_definition(&serde_json::json!({
            "id": "m",
            "displayName": "M",
        }))
        .unwrap();
        assert_eq!(unknown.context_window, None);
        assert!(unknown.snapshot()["contextWindow"].is_null());
    }

    #[test]
    fn model_definitions_normalize_declared_picker_options() {
        let model = StoredModel::from_definition(&serde_json::json!({
            "id": "family",
            "displayName": "Family",
            "options": {
                "efforts": [" Low", "high", "HIGH", ""],
                "defaultEffort": "High",
                "fast": true,
            },
        }))
        .unwrap();
        assert_eq!(
            model.options,
            ModelOptions {
                efforts: vec!["low".into(), "high".into()],
                default_effort: Some("high".into()),
                fast: true,
            }
        );
        assert_eq!(
            model.snapshot()["options"]["efforts"],
            serde_json::json!(["low", "high"])
        );

        // A default outside the declared levels is dropped; no options means no settings.
        let stray = StoredModel::from_definition(&serde_json::json!({
            "id": "m",
            "displayName": "M",
            "options": { "efforts": ["low"], "defaultEffort": "max" },
        }))
        .unwrap();
        assert_eq!(stray.options.default_effort, None);
        let plain = StoredModel::from_definition(&serde_json::json!({
            "id": "p",
            "displayName": "P",
        }))
        .unwrap();
        assert_eq!(plain.options, ModelOptions::default());
    }
}
