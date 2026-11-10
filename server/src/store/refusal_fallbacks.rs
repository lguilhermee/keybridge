//! Persists refusal fallbacks.
use std::collections::HashMap;

use sqlx::{Sqlite, Transaction};

use crate::{
    model::{normalize_refusal_fallbacks, RefusalFallback},
    Result,
};

use super::Store;

impl Store {
    pub async fn refusal_fallbacks(&self) -> Result<Vec<RefusalFallback>> {
        Ok(sqlx::query_as::<_, (String, String)>(
            "SELECT model_id, fallback_model_id FROM model_refusal_fallbacks ORDER BY model_id",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(model_id, fallback_model_id)| RefusalFallback {
            model_id,
            fallback_model_id,
        })
        .collect())
    }

    /// Refusal model per refusing model, for one run.
    pub async fn refusal_fallback_map(&self) -> Result<HashMap<String, String>> {
        Ok(self
            .refusal_fallbacks()
            .await?
            .into_iter()
            .map(|fallback| (fallback.model_id, fallback.fallback_model_id))
            .collect())
    }

    /// Atomically replaces the persisted refusal fallback mappings.
    pub async fn replace_refusal_fallbacks(
        &self,
        fallbacks: &[RefusalFallback],
    ) -> Result<Vec<RefusalFallback>> {
        let normalized = normalize_refusal_fallbacks(fallbacks)?;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM model_refusal_fallbacks")
            .execute(&mut *transaction)
            .await?;
        for entry in &normalized {
            sqlx::query(
                "INSERT INTO model_refusal_fallbacks(model_id, fallback_model_id) VALUES (?, ?)",
            )
            .bind(&entry.model_id)
            .bind(&entry.fallback_model_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        drop(_write);
        self.refusal_fallbacks().await
    }
}

/// Points both sides of every fallback at a model's new hash after an edit changed its identity.
pub(super) async fn rename_refusal_model(
    transaction: &mut Transaction<'_, Sqlite>,
    current: &str,
    next: &str,
) -> Result<()> {
    for column in ["model_id", "fallback_model_id"] {
        sqlx::query(&format!(
            "UPDATE model_refusal_fallbacks SET {column} = ? WHERE {column} = ?"
        ))
        .bind(next)
        .bind(current)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

/// Drops every fallback from or to a deleted model.
pub(super) async fn remove_refusal_model(
    transaction: &mut Transaction<'_, Sqlite>,
    model_id: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM model_refusal_fallbacks WHERE model_id = ? OR fallback_model_id = ?")
        .bind(model_id)
        .bind(model_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelConfigInput, ModelType};

    fn model(name: &str) -> ModelConfigInput {
        ModelConfigInput {
            sort_order: 0,
            display_name: name.into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "key".into(),
            tooltip_data: name.into(),
            model_id: name.into(),
            reasoning_effort: None,
            openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    fn pair(model_id: &str, fallback: &str) -> RefusalFallback {
        RefusalFallback {
            model_id: model_id.into(),
            fallback_model_id: fallback.into(),
        }
    }

    #[tokio::test]
    async fn fallbacks_round_trip_persist_across_restart_and_follow_model_edits_and_deletes() {
        let directory = tempfile::tempdir().unwrap();
        let db_url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&db_url).await.unwrap();
        let first = store.create_model(&model("first")).await.unwrap();
        let second = store.create_model(&model("second")).await.unwrap();

        store
            .replace_refusal_fallbacks(&[
                pair(&first.model_hash, &second.model_hash),
                pair("provider:x/a", &first.model_hash),
                pair("provider:x/b", "provider:x/a"),
            ])
            .await
            .unwrap();
        store
            .replace_refusal_fallbacks(&[
                pair(&first.model_hash, &second.model_hash),
                pair("provider:x/a", &first.model_hash),
            ])
            .await
            .unwrap();
        drop(store);

        let store = Store::connect(&db_url).await.unwrap();
        assert_eq!(store.refusal_fallbacks().await.unwrap().len(), 2);

        let mut renamed = model("first");
        renamed.api_key = "rotated-key".into();
        let edited = store
            .update_model(&first.model_hash, &renamed)
            .await
            .unwrap();
        assert_ne!(edited.model_hash, first.model_hash);
        let fallbacks = store.refusal_fallback_map().await.unwrap();
        assert_eq!(fallbacks.len(), 2);
        assert_eq!(fallbacks[&edited.model_hash], second.model_hash);
        assert_eq!(fallbacks["provider:x/a"], edited.model_hash);

        store
            .delete_models(std::slice::from_ref(&second.model_hash))
            .await
            .unwrap();
        let fallbacks = store.refusal_fallbacks().await.unwrap();
        assert_eq!(
            fallbacks,
            [RefusalFallback {
                model_id: "provider:x/a".into(),
                fallback_model_id: edited.model_hash,
            }]
        );
    }
}
