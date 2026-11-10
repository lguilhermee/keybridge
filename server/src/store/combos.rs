//! Persists combos and their members.
use std::str::FromStr;

use sqlx::{Row, Sqlite, Transaction};

use crate::{
    model::{normalize_combo_input, ComboConfig, ComboInput, ComboStrategy, COMBO_ID_PREFIX},
    Error, Result,
};

use super::{now_ms, Store};

const COMBO_COLUMNS: &str =
    "combo_id, sort_order, display_name, strategy, created_at_ms, updated_at_ms";

impl Store {
    pub async fn combos(&self) -> Result<Vec<ComboConfig>> {
        let rows = sqlx::query(&format!(
            "SELECT {COMBO_COLUMNS} FROM model_combos ORDER BY sort_order, display_name"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut combos = Vec::with_capacity(rows.len());
        for row in rows {
            let mut combo = combo_from_row(&row)?;
            combo.members = self.combo_members(&combo.combo_id).await?;
            combos.push(combo);
        }
        Ok(combos)
    }

    pub async fn combo(&self, combo_id: &str) -> Result<Option<ComboConfig>> {
        let Some(row) = sqlx::query(&format!(
            "SELECT {COMBO_COLUMNS} FROM model_combos WHERE combo_id = ?"
        ))
        .bind(combo_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let mut combo = combo_from_row(&row)?;
        combo.members = self.combo_members(combo_id).await?;
        Ok(Some(combo))
    }

    pub async fn create_combo(&self, input: &ComboInput) -> Result<ComboConfig> {
        let input = normalize_combo_input(input)?;
        let combo_id = format!(
            "{COMBO_ID_PREFIX}{}",
            &uuid::Uuid::new_v4().simple().to_string()[..16]
        );
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        ensure_unique_name(&mut transaction, &input.display_name, None).await?;
        sqlx::query(
            "INSERT INTO model_combos(combo_id, sort_order, display_name, strategy, created_at_ms, updated_at_ms)
             VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM model_combos), ?, ?, ?, ?)",
        )
        .bind(&combo_id)
        .bind(&input.display_name)
        .bind(input.strategy.as_str())
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        insert_members(&mut transaction, &combo_id, &input.members).await?;
        transaction.commit().await?;
        Ok(self
            .combo(&combo_id)
            .await?
            .expect("inserted combo must exist"))
    }

    pub async fn update_combo(&self, combo_id: &str, input: &ComboInput) -> Result<ComboConfig> {
        let input = normalize_combo_input(input)?;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        ensure_unique_name(&mut transaction, &input.display_name, Some(combo_id)).await?;
        let updated = sqlx::query(
            "UPDATE model_combos SET display_name = ?, strategy = ?, updated_at_ms = ? WHERE combo_id = ?",
        )
        .bind(&input.display_name)
        .bind(input.strategy.as_str())
        .bind(now_ms())
        .bind(combo_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("combo {combo_id}")));
        }
        sqlx::query("DELETE FROM model_combo_members WHERE combo_id = ?")
            .bind(combo_id)
            .execute(&mut *transaction)
            .await?;
        insert_members(&mut transaction, combo_id, &input.members).await?;
        transaction.commit().await?;
        Ok(self
            .combo(combo_id)
            .await?
            .expect("updated combo must exist"))
    }

    pub async fn delete_combo(&self, combo_id: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        let deleted = sqlx::query("DELETE FROM model_combos WHERE combo_id = ?")
            .bind(combo_id)
            .execute(&self.pool)
            .await?;
        if deleted.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("combo {combo_id}")));
        }
        Ok(())
    }

    /// Loads a combo for a new run and counts the run, so the loop strategy
    /// can rotate. Returns the combo with the number of runs started before this one.
    pub async fn start_combo_run(&self, combo_id: &str) -> Result<Option<(ComboConfig, u64)>> {
        let previous_runs = {
            let _write = self.writes.lock().await;
            sqlx::query(
                "UPDATE model_combos SET runs_started = runs_started + 1 WHERE combo_id = ?
                 RETURNING runs_started - 1 AS previous_runs",
            )
            .bind(combo_id)
            .fetch_optional(&self.pool)
            .await?
            .map(|row| row.try_get::<i64, _>("previous_runs"))
            .transpose()?
        };
        let Some(previous_runs) = previous_runs else {
            return Ok(None);
        };
        let combo = self.combo(combo_id).await?;
        Ok(combo.map(|combo| (combo, u64::try_from(previous_runs).unwrap_or_default())))
    }

    async fn combo_members(&self, combo_id: &str) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT model_id FROM model_combo_members WHERE combo_id = ? ORDER BY position",
        )
        .bind(combo_id)
        .fetch_all(&self.pool)
        .await?)
    }
}

/// Points combo members at a model's new hash after an edit changed its identity.
pub(super) async fn rename_combo_member(
    transaction: &mut Transaction<'_, Sqlite>,
    current: &str,
    next: &str,
) -> Result<()> {
    sqlx::query("UPDATE model_combo_members SET model_id = ? WHERE model_id = ?")
        .bind(next)
        .bind(current)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

/// Drops a deleted model from every combo.
pub(super) async fn remove_combo_member(
    transaction: &mut Transaction<'_, Sqlite>,
    model_id: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM model_combo_members WHERE model_id = ?")
        .bind(model_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn ensure_unique_name(
    transaction: &mut Transaction<'_, Sqlite>,
    display_name: &str,
    except: Option<&str>,
) -> Result<()> {
    let taken: Option<String> = sqlx::query_scalar(
        "SELECT combo_id FROM model_combos WHERE display_name = ? AND combo_id IS NOT ?",
    )
    .bind(display_name)
    .bind(except)
    .fetch_optional(&mut **transaction)
    .await?;
    if taken.is_some() {
        return Err(Error::Config(format!(
            "a combo named {display_name:?} already exists"
        )));
    }
    Ok(())
}

async fn insert_members(
    transaction: &mut Transaction<'_, Sqlite>,
    combo_id: &str,
    members: &[String],
) -> Result<()> {
    for (position, model_id) in members.iter().enumerate() {
        sqlx::query(
            "INSERT INTO model_combo_members(combo_id, position, model_id) VALUES (?, ?, ?)",
        )
        .bind(combo_id)
        .bind(i64::try_from(position).expect("member position fits in i64"))
        .bind(model_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

fn combo_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ComboConfig> {
    Ok(ComboConfig {
        combo_id: row.try_get("combo_id")?,
        sort_order: row.try_get("sort_order")?,
        display_name: row.try_get("display_name")?,
        strategy: ComboStrategy::from_str(row.try_get("strategy")?)?,
        members: Vec::new(),
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelConfigInput, ModelType};

    async fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        (directory, store)
    }

    fn model(name: &str) -> ModelConfigInput {
        ModelConfigInput {
            sort_order: 0,
            display_name: name.into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
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

    fn combo(name: &str, members: &[&str]) -> ComboInput {
        ComboInput {
            display_name: name.into(),
            strategy: ComboStrategy::Loop,
            members: members.iter().map(|member| (*member).into()).collect(),
        }
    }

    #[tokio::test]
    async fn combos_round_trip_and_count_runs() {
        let (_directory, store) = store().await;
        let created = store
            .create_combo(&combo("Best", &["b", "provider:x/a"]))
            .await
            .unwrap();
        assert!(created.combo_id.starts_with(COMBO_ID_PREFIX));
        assert_eq!(created.members, ["b", "provider:x/a"]);
        assert!(store.create_combo(&combo("Best", &["c"])).await.is_err());

        let updated = store
            .update_combo(&created.combo_id, &combo("Better", &["provider:x/a"]))
            .await
            .unwrap();
        assert_eq!(updated.display_name, "Better");
        assert_eq!(updated.members, ["provider:x/a"]);

        let (_, first) = store
            .start_combo_run(&created.combo_id)
            .await
            .unwrap()
            .unwrap();
        let (_, second) = store
            .start_combo_run(&created.combo_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((first, second), (0, 1));
        assert!(store
            .start_combo_run("combo:missing")
            .await
            .unwrap()
            .is_none());

        store.delete_combo(&created.combo_id).await.unwrap();
        assert!(store.combos().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn members_follow_model_edits_and_deletes() {
        let (_directory, store) = store().await;
        let first = store.create_model(&model("first")).await.unwrap();
        let second = store.create_model(&model("second")).await.unwrap();
        let created = store
            .create_combo(&combo("Pair", &[&first.model_hash, &second.model_hash]))
            .await
            .unwrap();

        let mut renamed = model("first");
        renamed.api_key = "rotated-key".into();
        let edited = store
            .update_model(&first.model_hash, &renamed)
            .await
            .unwrap();
        assert_ne!(edited.model_hash, first.model_hash);
        store
            .delete_models(std::slice::from_ref(&second.model_hash))
            .await
            .unwrap();

        let combo = store.combo(&created.combo_id).await.unwrap().unwrap();
        assert_eq!(combo.members, [edited.model_hash]);
    }
}
