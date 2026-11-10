//! Provides aggregate data for the control API.
//! Efficient database aggregates for the desktop overview.

use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::Row;

use crate::{
    model::{
        Overview, OverviewMetrics, OverviewModelUsage, TokenUsageBucket, TokenUsageGranularity,
    },
    Result,
};

use super::Store;

const OVERVIEW_DAYS: u64 = 365;
const MAX_RANGE_BUCKETS: i64 = 60;
const MAX_EXPLICIT_BUCKETS: i64 = 1440;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
const MAX_UTC_OFFSET_MINUTES: i32 = 14 * 60;

impl Store {
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
        utc_offset_minutes: Option<i32>,
    ) -> Result<Overview> {
        let offset_ms = utc_offset_ms(utc_offset_minutes);
        let call_row = sqlx::query(
            "SELECT
                COUNT(*) AS llm_calls,
                COALESCE(SUM(status = 'completed'), 0) AS successful_calls,
                COALESCE(SUM(status != 'completed'), 0) AS failed_calls
             FROM llm_calls
             WHERE status != 'running'
               AND (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_one(&self.pool)
        .await?;
        let token_row = sqlx::query(
            "SELECT
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_one(&self.pool)
        .await?;

        let input_tokens = non_negative(token_row.try_get("input_tokens")?);
        let cache_read_tokens = non_negative(token_row.try_get("cache_read_tokens")?);
        let cache_write_tokens = non_negative(token_row.try_get("cache_write_tokens")?);
        let output_tokens = non_negative(token_row.try_get("output_tokens")?);
        let prompt_tokens = saturating_sum(&[input_tokens, cache_read_tokens, cache_write_tokens]);

        let pricing = self.pricing_settings().await?;
        let model_rows = sqlx::query(
            "SELECT
                model_id,
                MAX(display_name) AS display_name,
                COALESCE(SUM(status != 'running'), 0) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))
             GROUP BY model_id
             ORDER BY (input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) DESC, model_id",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_all(&self.pool)
        .await?;
        let mut cost = 0.0_f64;
        let by_model = model_rows
            .into_iter()
            .map(|row| {
                let model_id: String = row.try_get("model_id")?;
                let model_input = non_negative(row.try_get("input_tokens")?);
                let model_cache_read = non_negative(row.try_get("cache_read_tokens")?);
                let model_cache_write = non_negative(row.try_get("cache_write_tokens")?);
                let model_output = non_negative(row.try_get("output_tokens")?);
                let (input_price, output_price, cache_read_price, cache_write_price) =
                    pricing.prices_for(&model_id);
                let model_cost = (model_input as f64 * input_price
                    + model_cache_read as f64 * cache_read_price
                    + model_cache_write as f64 * cache_write_price
                    + model_output as f64 * output_price)
                    / 1_000_000.0;
                cost += model_cost;
                Ok(OverviewModelUsage {
                    model_id,
                    display_name: row.try_get("display_name")?,
                    calls: row.try_get("calls")?,
                    input_tokens: model_input,
                    cache_read_tokens: model_cache_read,
                    cache_write_tokens: model_cache_write,
                    output_tokens: model_output,
                    cost: model_cost,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let metrics = OverviewMetrics {
            llm_calls: call_row.try_get("llm_calls")?,
            successful_calls: call_row.try_get("successful_calls")?,
            failed_calls: call_row.try_get("failed_calls")?,
            token_usage: prompt_tokens.saturating_add(output_tokens),
            prompt_tokens,
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            cost,
        };

        let (token_usage_granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(start_ms, end_ms, bucket_ms, offset_ms);
        let rows = sqlx::query(&format!(
            "SELECT
                ((created_at_ms + {offset_ms}) / {bucket_ms}) * {bucket_ms} - {offset_ms} AS bucket_start_ms,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
        ))
        .bind(start_ms.unwrap_or(series_start_ms).max(series_start_ms))
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_all(&self.pool)
        .await?;
        let mut recorded = rows
            .into_iter()
            .map(|row| {
                let bucket_start_ms: i64 = row.try_get("bucket_start_ms")?;
                Ok((
                    bucket_start_ms,
                    TokenUsageBucket {
                        bucket_start_ms,
                        input_tokens: non_negative(row.try_get("input_tokens")?),
                        cache_read_tokens: non_negative(row.try_get("cache_read_tokens")?),
                        cache_write_tokens: non_negative(row.try_get("cache_write_tokens")?),
                        output_tokens: non_negative(row.try_get("output_tokens")?),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let token_usage_series = (0..bucket_count)
            .map(|offset| series_start_ms.saturating_add(offset.saturating_mul(bucket_ms)))
            .map(|bucket_start_ms| {
                recorded
                    .remove(&bucket_start_ms)
                    .unwrap_or(TokenUsageBucket {
                        bucket_start_ms,
                        ..TokenUsageBucket::default()
                    })
            })
            .collect();

        Ok(Overview {
            metrics,
            token_usage_granularity,
            token_usage_series,
            by_model,
        })
    }
}

fn token_usage_buckets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    requested_bucket_ms: Option<i64>,
    offset_ms: i64,
) -> (TokenUsageGranularity, i64, i64, i64) {
    if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
        let duration_ms = end_ms.saturating_sub(start_ms).max(1);
        let explicit_bucket_ms = requested_bucket_ms.filter(|bucket_ms| *bucket_ms >= MINUTE_MS);
        let bucket_ms = explicit_bucket_ms.unwrap_or({
            if duration_ms <= HOUR_MS {
                MINUTE_MS
            } else if duration_ms <= MAX_RANGE_BUCKETS * HOUR_MS {
                HOUR_MS
            } else {
                DAY_MS
            }
        });
        let granularity = if bucket_ms < HOUR_MS {
            TokenUsageGranularity::Minute
        } else if bucket_ms < DAY_MS {
            TokenUsageGranularity::Hour
        } else {
            TokenUsageGranularity::Day
        };
        let max_buckets = if explicit_bucket_ms.is_some() {
            MAX_EXPLICIT_BUCKETS
        } else {
            MAX_RANGE_BUCKETS
        };
        let last_bucket_ms = bucket_floor(end_ms.saturating_sub(1), bucket_ms, offset_ms);
        let first_bucket_ms = bucket_floor(start_ms, bucket_ms, offset_ms);
        let bucket_count =
            ((last_bucket_ms - first_bucket_ms).div_euclid(bucket_ms) + 1).clamp(1, max_buckets);
        let series_start_ms =
            last_bucket_ms.saturating_sub((bucket_count - 1).saturating_mul(bucket_ms));
        return (granularity, bucket_ms, series_start_ms, bucket_count);
    }

    let today_start_ms = bucket_floor(Utc::now().timestamp_millis(), DAY_MS, offset_ms);
    let series_start_ms = today_start_ms.saturating_sub(
        i64::try_from(OVERVIEW_DAYS - 1)
            .unwrap_or(0)
            .saturating_mul(DAY_MS),
    );
    (
        TokenUsageGranularity::Day,
        DAY_MS,
        series_start_ms,
        i64::try_from(OVERVIEW_DAYS).unwrap_or(0),
    )
}

fn utc_offset_ms(utc_offset_minutes: Option<i32>) -> i64 {
    i64::from(
        utc_offset_minutes
            .unwrap_or(0)
            .clamp(-MAX_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES),
    ) * MINUTE_MS
}

fn bucket_floor(timestamp_ms: i64, bucket_ms: i64, offset_ms: i64) -> i64 {
    timestamp_ms
        .saturating_add(offset_ms)
        .div_euclid(bucket_ms)
        .saturating_mul(bucket_ms)
        .saturating_sub(offset_ms)
}

fn non_negative(value: i64) -> i64 {
    value.max(0)
}

fn saturating_sum(values: &[i64]) -> i64 {
    values
        .iter()
        .fold(0_i64, |total, value| total.saturating_add(*value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{NewLlmCall, ProtocolType, Usage},
        store::{ModelTokenPricing, TokenPricingSettings},
    };

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

    async fn record(store: &Store, call_id: &str, protocol_type: ProtocolType, usage: Usage) {
        record_model(store, call_id, "model", "Model", protocol_type, usage).await
    }

    async fn record_model(
        store: &Store,
        call_id: &str,
        model_id: &str,
        display_name: &str,
        protocol_type: ProtocolType,
        usage: Usage,
    ) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: format!("run-{call_id}"),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "model".into(),
                protocol_type,
                endpoint_url: "https://example.test".into(),
                model_id: model_id.into(),
                display_name: display_name.into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        store.record_llm_usage(call_id, usage).await.unwrap();
        store
            .finish_llm_call(call_id, "completed", None, 10, None, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn overview_sums_non_cached_input_for_every_source() {
        let (_directory, store) = store().await;
        record(
            &store,
            "provider",
            ProtocolType::Provider,
            Usage {
                input_tokens: Some(10),
                context_input_tokens: Some(60),
                output_tokens: Some(5),
                total_tokens: Some(65),
                cache_read_tokens: Some(20),
                cache_write_tokens: Some(30),
                reasoning_tokens: None,
            },
        )
        .await;
        record(
            &store,
            "openai",
            ProtocolType::OpenAiChat,
            Usage {
                input_tokens: Some(60),
                context_input_tokens: Some(100),
                output_tokens: Some(7),
                total_tokens: Some(107),
                cache_read_tokens: Some(40),
                cache_write_tokens: None,
                reasoning_tokens: None,
            },
        )
        .await;

        let overview = store.overview(None, None, None, None, None).await.unwrap();

        assert_eq!(overview.metrics.input_tokens, 70);
        assert_eq!(overview.metrics.cache_read_tokens, 60);
        assert_eq!(overview.metrics.cache_write_tokens, 30);
        assert_eq!(overview.metrics.output_tokens, 12);
        assert_eq!(overview.metrics.prompt_tokens, 160);
        assert_eq!(overview.metrics.token_usage, 172);
        let series_input: i64 = overview
            .token_usage_series
            .iter()
            .map(|bucket| bucket.input_tokens)
            .sum();
        assert_eq!(series_input, 70);
    }

    fn ms(timestamp: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn one_local_day_is_one_bucket_starting_at_local_midnight() {
        let start = ms("2026-01-10T03:00:00Z");
        let end = ms("2026-01-11T03:00:00Z");

        let (granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(Some(start), Some(end), Some(DAY_MS), -180 * MINUTE_MS);

        assert_eq!(granularity, TokenUsageGranularity::Day);
        assert_eq!(bucket_ms, DAY_MS);
        assert_eq!(series_start_ms, start);
        assert_eq!(bucket_count, 1);
    }

    #[test]
    fn half_hour_offsets_start_buckets_on_the_local_boundary() {
        let start = ms("2026-01-09T18:30:00Z");
        let end = ms("2026-01-10T18:30:00Z");

        let (_, _, series_start_ms, bucket_count) =
            token_usage_buckets(Some(start), Some(end), Some(DAY_MS), 330 * MINUTE_MS);

        assert_eq!(series_start_ms, start);
        assert_eq!(bucket_count, 1);
    }

    #[test]
    fn utc_offsets_outside_fourteen_hours_are_clamped() {
        assert_eq!(utc_offset_ms(None), 0);
        assert_eq!(utc_offset_ms(Some(-180)), -180 * MINUTE_MS);
        assert_eq!(utc_offset_ms(Some(100_000)), 840 * MINUTE_MS);
        assert_eq!(utc_offset_ms(Some(-100_000)), -840 * MINUTE_MS);
    }

    #[tokio::test]
    async fn calls_either_side_of_local_midnight_land_in_different_days() {
        let (_directory, store) = store().await;
        let usage = |input| Usage {
            input_tokens: Some(input),
            ..Default::default()
        };
        record(&store, "late-evening", ProtocolType::Anthropic, usage(1)).await;
        record(&store, "after-midnight", ProtocolType::Anthropic, usage(2)).await;
        for (call_id, created_at) in [
            ("late-evening", ms("2026-01-11T02:30:00Z")),
            ("after-midnight", ms("2026-01-11T03:30:00Z")),
        ] {
            sqlx::query("UPDATE llm_calls SET created_at_ms = ? WHERE call_id = ?")
                .bind(created_at)
                .bind(call_id)
                .execute(&store.pool)
                .await
                .unwrap();
        }

        let overview = store
            .overview(
                Some(ms("2026-01-10T03:00:00Z")),
                Some(ms("2026-01-12T03:00:00Z")),
                None,
                Some(DAY_MS),
                Some(-180),
            )
            .await
            .unwrap();

        let buckets: Vec<(i64, i64)> = overview
            .token_usage_series
            .iter()
            .map(|bucket| (bucket.bucket_start_ms, bucket.input_tokens))
            .collect();
        assert_eq!(
            buckets,
            vec![
                (ms("2026-01-10T03:00:00Z"), 1),
                (ms("2026-01-11T03:00:00Z"), 2),
            ]
        );
    }

    #[tokio::test]
    async fn by_model_groups_tokens_and_prices_per_model_override() {
        let (_directory, store) = store().await;
        let usage = |input, output| Usage {
            input_tokens: Some(input),
            output_tokens: Some(output),
            ..Default::default()
        };
        record_model(
            &store,
            "a1",
            "model-a",
            "Model A",
            ProtocolType::Provider,
            usage(1_000_000, 100_000),
        )
        .await;
        record_model(
            &store,
            "a2",
            "model-a",
            "Model A",
            ProtocolType::Provider,
            usage(500_000, 0),
        )
        .await;
        record_model(
            &store,
            "b1",
            "model-b",
            "Model B",
            ProtocolType::Provider,
            usage(0, 200_000),
        )
        .await;
        // A still-running call contributes its reported tokens but not a call count.
        store
            .start_llm_call(&NewLlmCall {
                call_id: "live".into(),
                run_id: "run-live".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "model".into(),
                protocol_type: ProtocolType::Provider,
                endpoint_url: "https://example.test".into(),
                model_id: "model-a".into(),
                display_name: "Model A".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        store
            .record_llm_usage("live", usage(50_000, 10_000))
            .await
            .unwrap();

        // Global pricing: input 5, output 25. Override model-a's input to 1.
        store
            .set_pricing_settings(TokenPricingSettings {
                input_per_million: 5.0,
                output_per_million: 25.0,
                cache_read_per_million: 0.5,
                cache_write_per_million: 6.25,
                model_prices: [(
                    "model-a".to_owned(),
                    ModelTokenPricing {
                        input_per_million: Some(1.0),
                        ..Default::default()
                    },
                )]
                .into_iter()
                .collect(),
            })
            .await
            .unwrap();

        let overview = store.overview(None, None, None, None, None).await.unwrap();

        assert_eq!(overview.by_model.len(), 2);
        let model_a = &overview.by_model[0];
        assert_eq!(model_a.model_id, "model-a");
        assert_eq!(model_a.display_name, "Model A");
        assert_eq!(model_a.calls, 2);
        assert_eq!(model_a.input_tokens, 1_550_000);
        assert_eq!(model_a.output_tokens, 110_000);
        // model-a: (1.55M * 1 + 110k * 25) / 1M = 4.30
        assert!((model_a.cost - 4.30).abs() < 1e-9);
        let model_b = &overview.by_model[1];
        assert_eq!(model_b.model_id, "model-b");
        assert_eq!(model_b.calls, 1);
        // model-b uses global prices: 200k * 25 / 1M = 5.0
        assert!((model_b.cost - 5.0).abs() < 1e-9);
        assert!((overview.metrics.cost - 9.30).abs() < 1e-9);
    }
}
