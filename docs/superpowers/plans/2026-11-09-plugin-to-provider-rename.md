# Plugin → Provider / Channel / Protocol Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the account-integration concept from "plugin" to "provider" everywhere — modules, types, wire strings, storage, HTTP API, and UI — while introducing "channel" for the model source inside a provider and "protocol" for the transport adapters. Old persisted data moves once.

**Architecture:** `server/src/provider/` (protocol adapters) becomes `server/src/protocol/`; `server/src/plugin/` becomes `server/src/provider/`; `server/plugins/build-in/` becomes `server/providers/built-in/`; the SDK's `plugin.ts` becomes `provider.ts` and `provider.ts` becomes `channel.ts`. The `llm_calls` table keeps one protocol/endpoint pair (the current `provider_*` columns renamed — `request_*` columns are exact duplicates and are dropped).

**Tech Stack:** Rust (axum, sqlx, tokio), TypeScript/Deno plugin SDK, React desktop frontend.

**Spec:** `docs/superpowers/specs/2026-11-09-ui-redesign-design.md`, "Step 2: rename".

**Baseline:** branch `real-tokenizer` at `1b13697`. Create branch `provider-rename` from it.

## Naming Map (the contract — apply exactly)

| Concept | Old | New |
|---|---|---|
| Rust module: transport adapters | `crate::provider::{anthropic,openai_chat,openai_responses,router,recorder,Provider}` | `crate::protocol::{...}` (trait `Provider` → `Protocol`) |
| Rust module: account integrations | `crate::plugin` | `crate::provider` |
| Protocol enum | `ProviderType::{OpenAiChat,OpenAiResponses,Anthropic,Plugin}` | `ProtocolType::{... ,Provider}` (serde `plugin` → `provider`) |
| `ModelConfig` method | `provider_type()` | `protocol_type()` |
| Replay-state kind field | `provider_kind` / `providerKind` | `protocol_kind` / `protocolKind` |
| Stable model ID | `plugin:<plugin>/<provider>/<model>` | `provider:<provider>/<channel>/<model>` (`ADAPTER_ID_PREFIX` → `"provider:"`) |
| Stored endpoint URL | `plugin://<plugin>/<provider>` | `provider://<provider>/<channel>` |
| `llm_calls` columns | `provider_type`,`provider_url`,`request_type`,`request_url` | `protocol_type`,`endpoint_url` (request_* dropped — see Note A) |
| `NewLlmCall`/`LlmCallSummary` fields | same four | `protocol_type`,`endpoint_url` |
| Control API routes | `/api/plugins/...`, `plugin_id`, `provider_id` params | `/api/providers/...`, `provider_id`, `channel_id` params |
| Manifest file | `plugin.json` | `provider.json` |
| Manifest/loader version | `PLUGIN_API_VERSION` | `PROVIDER_API_VERSION` (value stays `1`) |
| Data root | `~/.cursor-byok-v3/plugins/{installed,data,runtime}` | `~/.cursor-byok-v3/providers/{installed,data,runtime}` |
| Source tree | `server/plugins/build-in/` | `server/providers/built-in/` |
| Rust types | `Plugin*` (`PluginRegistry`, `PluginRuntime*`, `PluginManifest`, `PluginDescriptor`, `PluginModelDescriptor`, `PluginStateStore`, `PluginDataStore`, ...) | `Provider*` equivalents |
| Inner-provider descriptor | `PluginProviderDescriptor` / JSON `providerType` | `ChannelDescriptor` / JSON `brand` |
| Descriptor JSON fields | `pluginId`, `pluginName`, `providers[]`, `providerId` | `providerId`, `providerName`, `channels[]`, `channelId` |
| Worker message params | `providerId` (channel selector) | `channelId` |
| SDK files/specifiers | `sdk/plugin.ts` (`cursor-byok:plugin`), `sdk/provider.ts` (`cursor-byok:provider`) | `sdk/provider.ts` (`cursor-byok:provider`), `sdk/channel.ts` (`cursor-byok:channel`) |
| SDK types | `defineProviderPlugin`, `ProviderPluginDefinition{providers}`, `PluginContext`, `ProviderSupport`, `ProviderInvokeInput/Output/Result`, `__getRegisteredPlugin` | `defineProvider`, `ProviderDefinition{channels}`, `ProviderContext`, `ChannelSupport`, `ChannelInvokeInput/Output/Result`, `__getRegisteredProvider` |
| Provider IDs | `dev.cursorbyok.providers.{claude,devin,opencode}` stay; `dev.cursorbyok.plugins.antigravity-auth` → `dev.cursorbyok.providers.antigravity-auth`; `dev.cursorbyok.examples.{codex,grok}-auth` → `dev.cursorbyok.providers.{codex,grok}-auth` | all under `dev.cursorbyok.providers.*` |
| Frontend | `/plugins` route, `features/plugins`, `Plugin*` components/types, `plugin:` prefix checks, `provider_type`/`request_*` call fields | `/providers`, `features/providers`, `Provider*`/`Channel*`, `provider:` checks, `protocol_type`/`endpoint_url` |

**NOT renamed (false positives — leave untouched):**
- `apps/desktop/plugins/static-i18n-plugin.ts`, `vite*.config.ts` `plugins:` arrays, `@vitejs/plugin-react`, `code-inspector-plugin`, `tsconfig.node.json` `plugins/**` include — Vite plugin concept.
- All `@tauri-apps/plugin-*` deps, `tauri_plugin_*` crates, `.plugin(...)` builder calls, `tauri.conf.json` `"plugins"`, `apps/desktop/src-tauri/Cargo.toml`.
- `apps/desktop/package*.json`.
- Existing migration files (`server/migrations/0001`–`0011`) — never modify; the rename of historical rows happens in `0012`.
- `provider_endpoints`/`provider_models`/`provider_type` inside old migration SQL — dead tables, ignore.
- `package-lock.json`, generated `apps/desktop/src/i18n/generated/catalog.json` (regenerated by `i18n:scan`, not edited).

**Note A — column collapse:** every writer today sets `provider_type == request_type` and `provider_url == request_url` (verified: `api/byok/direct.rs:60-70`, `provider/router.rs:206-220`). `LlmCallSummary` drops the `request_type`/`request_url` JSON fields; the frontend `LlmCall` type loses them too.

## Global Constraints

- Each task's commit must compile/test cleanly — no "temporary broken" commits.
- `CARGO_TARGET_DIR=target/devin-test` on every cargo command. Gate: no NEW failures vs the four known pre-existing failures + the two known fmt-drift files.
- Deno tests run per plugin dir with the bundled runtime (`$DENO` = `~/.cursor-byok-v3/plugins/runtime/deno/*/x86_64-pc-windows-msvc/deno.exe` — note: after Task 4 the runtime dir may live under `providers/`; check both).
- `git mv` for every file/dir move to keep history.
- No compatibility shims: old route names, old specifiers, old manifest names are deleted, not aliased.
- User-visible strings go through `t()` (zh-CN source literals); renaming a shown string means updating the `t()` call and both locale files, then `npm run i18n:scan`.

## Review Focus

1. The `provider:`/`provider://` rewrite must not hit Tauri/Vite/plugin-unrelated strings — the word "plugin" also means Vite plugins and Tauri plugins. Every replacement is scoped to the map above.
2. `plugin:`/`plugin://` literals inside **persisted user data paths** (settings JSON, llm_calls) are covered by migration `0012` AND the startup dir move; code never reads old spellings.
3. `providerType` appears both as the channel's brand field AND as `provider_type` Rust fields on descriptors/configs — map each occurrence to `brand` or `protocol_type` by context, not blind sed.
4. `PluginProviderDescriptor` (inner provider → channel) vs `PluginDescriptor` (outer → provider): the same word "provider" lands on opposite sides of the rename. Check every site.
5. Built-in plugin sources import `cursor-byok:plugin`, `cursor-byok:provider`, `cursor-byok:model`, `cursor-byok:resource`, `cursor-byok:protocol/*` — specifier `cursor-byok:provider` changes meaning from "channel.ts" to "provider.ts"; every built-in import must be re-pointed, not just renamed.
6. `plugins/runtime` holds downloaded Deno binaries — the startup move must preserve it (move, not redownload). `plugins/installed` holds user data; `plugins/data/<plugin-id>/` holds per-provider state — the three renamed provider IDs need their `data/` subdirs renamed.

---

### Task 1: Move the two source modules

**Files:**
- `git mv server/src/provider server/src/protocol`
- `git mv server/src/plugin server/src/provider`
- Update `server/src/lib.rs` mod declarations and every `crate::plugin::` / `crate::provider::` path.

**Rules:** `crate::plugin::X` → `crate::provider::X`; references to the OLD provider module (`crate::provider::{anthropic, openai_chat, openai_responses, router, recorder, Provider, native_usage, provider_kind,...}`) → `crate::protocol::{...}`. Nothing else changes — type names keep their old spellings for now (the `Provider` trait stays `Provider`, `ProviderType` stays `ProviderType`, etc.).

- [ ] **Step 1:** `git mv` both directories; update `mod provider;`/`mod plugin;` in `lib.rs` to `mod protocol;`/`mod provider;` (keep alphabetical order of mod declarations if the file has one).
- [ ] **Step 2:** Fix imports until `CARGO_TARGET_DIR=target/devin-test cargo check -p cursor-server --all-targets` passes. Do NOT rename any type or string in this commit.
- [ ] **Step 3:** `cargo test -p cursor-server --all-targets` — same failures as baseline only.
- [ ] **Step 4:** Commit: `"Move protocol adapters to server/src/protocol and the integration host to server/src/provider"` + Devin trailer.

---

### Task 2: Rust identifier renames (wire strings unchanged)

**Scope:** every Rust type/function/field/variable in the map, EXCEPT serialized strings (`serde rename`, `as_str`/`FromStr` literals, `ADAPTER_ID_PREFIX` value, route paths, `plugin.json`, `plugin:`/`plugin://` literals, `~/.cursor-byok-v3/plugins` paths, `plugins/build-in` include paths — those are Tasks 3/4). Interim inconsistency (e.g. `ProtocolType::Provider` serializing `"plugin"`) is expected for exactly one commit.

**Files:** all of `server/src` + `server/tests` — mechanically:
- `ProviderType` → `ProtocolType`; variant `Plugin` → `Provider` (keep `#[serde(rename = "plugin")]` and the `"plugin"` match arm until Task 3).
- `ModelConfig::provider_type()` → `protocol_type()`.
- `Plugin` prefix on public types → `Provider` (`PluginRegistry`→`ProviderRegistry`, `PluginRuntime`/`Phase`/`State`/`Status`, `PluginManifest`, `PluginPermissions`, `PluginDescriptor`, `PluginModelDescriptor`, `PluginResourceDescriptor`, `PluginResourceView`, `PluginStateStore`, `PluginDataStore`, `PluginCatalog`, `PluginRuntime...`).
- `PluginProviderDescriptor` → `ChannelDescriptor`; `plugin_id`/`plugin_name` fields on descriptors → `provider_id`/`provider_name`; `provider_id` (inner) fields → `channel_id`.
- `provider_type` field on the channel descriptor → `brand`; `provider_kind`/`ProviderReplayState.provider_kind` → `protocol_kind`.
- `NewLlmCall`/`LlmCallSummary`: `provider_type`→`protocol_type`, `provider_url`→`endpoint_url`; DELETE `request_type`/`request_url` fields and their column reads/writes (INSERT statement drops the two columns — Task 3's migration drops them in the table; keep the INSERT writing `request_*` columns in THIS task since the table still has them — i.e. keep four binds in SQL but remove the struct fields? NO — simpler: keep struct fields `request_type`/`request_url` named as-is until Task 3. This task only renames the `provider_*` pair.)
- `Provider` trait → `Protocol` trait (`crate::protocol::Provider`→`crate::protocol::Protocol`); `provider_kind(` fn → `protocol_kind`.
- `model_catalog.rs` `plugin_id` field → `provider_id`; `provider_type` (vendor label) → `brand`.
- Control/service handler names `plugin_*` → `provider_*`; `plugins::list` module fn names → `providers::*` (module `control/plugins.rs` → `control/providers.rs` via `git mv`).
- Test files: update all uses.

- [ ] **Step 1:** Apply renames mechanically; `cargo check` until green. `serde rename`/`as_str`/`FromStr` literals stay exactly as they are.
- [ ] **Step 2:** `cargo test -p cursor-server --all-targets` — baseline failures only. `cargo fmt --all` on touched files (do not touch the two drift files; run `rustfmt --edition 2021 <file>` per touched file, or `cargo fmt` and revert the two).
- [ ] **Step 3:** `cargo clippy -p cursor-server --all-targets -- -D warnings` clean.
- [ ] **Step 4:** Commit: `"Rename plugin and provider types to provider, channel, and protocol in the server"` + trailer.

---

### Task 3: Wire strings, columns, and migration 0012

**Scope:** every persisted/serialized spelling.

- [ ] **Step 1 — enum strings:** `ProtocolType` serde `plugin`→`provider`, `as_str` → `"provider"`, `FromStr` arm → `"provider"`.
- [ ] **Step 2 — literals:** `ADAPTER_ID_PREFIX` → `"provider:"`; `parse_model_id`/`model_id` fns produce `provider:<provider>/<channel>/<model>`; every `"plugin://"` literal → `"provider://"`; every `"plugin:"` prefix check (`starts_with`, `strip_prefix`) → `"provider:"`. Sites: `provider/descriptor.rs`, `api/byok/models.rs` (`"plugin:{}:{}/{}"` format → `"provider:{}:{}/{}"`), `api/cursor/handlers.rs:242`, `control/service.rs:383`, `cursor/services/commit_message.rs`, `cursor/services/model_catalog.rs` (incl. test literals `plugin:test/provider/model`→`provider:test/channel/model`), `cursor/transport/registry.rs`, `protocol/router.rs`, `store/llm_calls.rs` tests.
- [ ] **Step 3 — columns:** `NewLlmCall` drops `request_type`/`request_url`; `start_llm_call` INSERT drops those columns; `LlmCallSummary` drops `request_*`; `llm_calls` SELECT/row-mapping drops them. All writers now set only `protocol_type`+`endpoint_url` (delete the duplicate assignments).
- [ ] **Step 4 — endpoints:** `control/mod.rs` routes `/api/plugins` → `/api/providers`; path params `plugin_id`→`provider_id`, the inner `provider_id`→`channel_id` (so `…/providers/{provider_id}/channels/{channel_id}/models/sync|enabled`); `control/providers.rs` handler params + `service.rs` method signatures updated. Filename in content-disposition `"{plugin_id}-{resource_type}.json"` → provider_id.
- [ ] **Step 5 — descriptor JSON:** `PluginProviderDescriptor` (now `ChannelDescriptor`) field `provider_type` serializes as `brand`; descriptor structs' `plugin_id`→`provider_id`, `plugin_name`→`provider_name`, `provider_id`→`channel_id`; the collected-descriptor `providers` array key → `channels` (Rust side: wherever `__descriptor` output is deserialized, e.g. `provider/descriptor.rs` or `registry.rs` — find the struct that reads `providers` and rename to `channels`).
- [ ] **Step 6 — migration `0012_rename_llm_call_provider_columns.sql`:**

```sql
-- plugin → provider rename: collapse the duplicate request_* pair into
-- protocol_type/endpoint_url and rewrite stored plugin identifiers.
ALTER TABLE llm_calls DROP COLUMN request_type;
ALTER TABLE llm_calls DROP COLUMN request_url;
ALTER TABLE llm_calls RENAME COLUMN provider_type TO protocol_type;
ALTER TABLE llm_calls RENAME COLUMN provider_url TO endpoint_url;

UPDATE llm_calls SET protocol_type = 'provider' WHERE protocol_type = 'plugin';
UPDATE llm_calls SET endpoint_url = replace(endpoint_url, 'plugin://', 'provider://')
WHERE endpoint_url LIKE 'plugin://%';
UPDATE llm_calls SET model_id = replace(model_id, 'plugin:', 'provider:')
WHERE model_id LIKE 'plugin:%';

-- The three provider IDs that changed namespace.
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.plugins.antigravity-auth', 'dev.cursorbyok.providers.antigravity-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.plugins.antigravity-auth', 'dev.cursorbyok.providers.antigravity-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.plugins.antigravity-auth%' OR model_id LIKE '%dev.cursorbyok.plugins.antigravity-auth%';
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.examples.codex-auth', 'dev.cursorbyok.providers.codex-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.examples.codex-auth', 'dev.cursorbyok.providers.codex-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.examples.codex-auth%' OR model_id LIKE '%dev.cursorbyok.examples.codex-auth%';
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.examples.grok-auth', 'dev.cursorbyok.providers.grok-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.examples.grok-auth', 'dev.cursorbyok.providers.grok-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.examples.grok-auth%' OR model_id LIKE '%dev.cursorbyok.examples.grok-auth%';

-- Commit-message model setting (service_settings.value_json -> $.modelId).
UPDATE service_settings
SET value_json = json_replace(
    value_json,
    '$.modelId',
    replace(json_extract(value_json, '$.modelId'), 'plugin:', 'provider:')
)
WHERE setting_key = 'commit'
  AND json_extract(value_json, '$.modelId') LIKE 'plugin:%';
```

Verify the actual `setting_key` for commit settings in `store/settings.rs` before writing the file (search for the constant feeding `.bind(...)` next to `CommitSettings`); also apply the three ID renames inside `modelId` if it can carry full `provider:<id>/…` strings — since `replace` on the prefix covers `plugin:`→`provider:` but NOT the inner id strings, add a second json_replace pass for each renamed id, or use nested `replace` calls. Confirm by checking what values commit `model_id` can hold (`plugin:<id>/...`).

- [ ] **Step 7 — migration test** (in `store/migrations.rs` tests, same pattern as the 0011 test): run migrations 1–11, insert `llm_calls` rows (`request_type='plugin'`, `request_url='plugin://dev.cursorbyok.plugins.antigravity-auth/vertex'`, `model_id='plugin:dev.cursorbyok.plugins.antigravity-auth/vertex/gemini'`, plus one `'openai-chat'` row and one NULL-usage row) and a commit `service_settings` row with `modelId='plugin:dev.cursorbyok.examples.grok-auth/grok/grok-3'`; run all migrations; assert columns renamed (query `PRAGMA table_info(llm_calls)` — no `request_type`/`request_url`, `protocol_type`/`endpoint_url` present), `protocol_type='provider'`, URLs/IDs rewritten to `provider://`/`provider:` with `providers.` namespace ids, `modelId='provider:dev.cursorbyok.providers.grok-auth/grok/grok-3'`, untouched rows intact. Also update the version-list assertion `[1..11]` → `[1..12]`.
- [ ] **Step 8 — server tests:** update `external_api.rs`, `tool_round.rs`, `llm_calls.rs` tests, `store/migrations.rs` literals (`plugin://dev.cursorbyok.providers.claude/claude` → `provider://...`), `provider/recorder.rs` test literals.
- [ ] **Step 9 — gate:** fmt (touched files only), clippy, `cargo test -p cursor-server --all-targets` — baseline failures only. Remember the `sqlx::migrate!` staleness note: if new migration isn't picked up, `touch server/src/lib.rs` or build.rs now has `rerun-if-changed=migrations` (should rebuild — verify).
- [ ] **Step 10:** Commit: `"Rename stored plugin identifiers and the call-history columns to provider terms"` + trailer.

---

### Task 4: Provider package format — manifests, SDK, built-in tree, disk layout

**Scope:** everything a provider package touches: `server/plugins/` → `server/providers/`, `plugin.json` → `provider.json`, SDK file/type/specifier renames, built-in provider IDs + versions, installed/data/runtime dir move.

- [ ] **Step 1 — tree moves:**
  - `git mv server/plugins server/providers`
  - `git mv server/providers/build-in server/providers/built-in`
  - Inside `server/src/provider/sdk/`: `git mv plugin.ts provider.ts; git mv provider.ts channel.ts` (order matters — do the second first or use a temp name).
  - `import-map.json`: `"cursor-byok:provider": "./provider.ts"`, `"cursor-byok:channel": "./channel.ts"` (drop `cursor-byok:plugin`).
  - Update the new `provider.ts` (was plugin.ts): `PluginContext`→`ProviderContext`, `ProviderPluginDefinition`→`ProviderDefinition` with `channels: ChannelSupport[]`, `defineProviderPlugin`→`defineProvider`, `__getRegisteredPlugin`→`__getRegisteredProvider`, `__descriptor` emits `channels:` (from `definition.channels`, each `{id, displayName, description, brand, resourceType, hasModels}` — wait: `providerType` field → `brand`), imports from `./channel.ts`.
  - `channel.ts` (was provider.ts): `ProviderSupport`→`ChannelSupport` (`providerType`→`brand`), `ProviderInvokeInput`→`ChannelInvokeInput`, `ProviderOutput`→`ChannelOutput`, `ProviderResult`→`ChannelResult`, `LlmReplayState.providerKind`→`protocolKind`, `PluginContext`→`ProviderContext`, import `./provider.ts`.
  - `model.ts`, `resource.ts`: `PluginContext`→`ProviderContext` import from `./provider.ts`; "plugin" doc comments → provider.
  - `worker.ts`: `cursor-byok:plugin`→`cursor-byok:provider` specifier, `__getRegisteredProvider`, `plugin` var→`provider`, `plugin.providers`→`provider.channels`, `params.providerId`→`params.channelId`, error strings.
  - `collect.ts`: same specifier + `__getRegisteredProvider`.
- [ ] **Step 2 — host side:** `builtin.rs` `include_str!` paths `plugins/build-in`→`providers/built-in` and `plugin.json`→`provider.json`; `manifest.rs` expects `provider.json` (`PluginManifest` type already renamed in Task 2 — now the FILE name: find where the loader joins `plugin.json`, change to `provider.json`; `PLUGIN_API_VERSION`→`PROVIDER_API_VERSION`); `catalog.rs`/`installation.rs`/`runtime.rs`/`data.rs` dir literals `plugins/installed|data|runtime|build-in` → `providers/…`; descriptor `__descriptor` parse sites `providers`→`channels`; worker spawn specifiers if the host injects the import map path (check `worker.rs`/`runtime.rs` for `import-map.json` or `cursor-byok:` references — `collect.ts`/`worker.ts` are launched with `--import-map`? find and keep pointing at the sdk dir).
- [ ] **Step 3 — built-in providers:** each `*/plugin.json` → `provider.json` (`git mv`); update its `"id"` if renamed per the map (antigravity, codex, grok); bump every manifest `"version"` patch (`0.1.9`→`0.2.0` — pick `.x+1` minor bump: `0.1.9`→`0.2.0`, `0.1.5`→`0.2.0`, etc.) so installed copies resync. In each provider's sources: `import { defineProviderPlugin } from "cursor-byok:plugin"` → `import { defineProvider } from "cursor-byok:provider"`; `providers: [` → `channels: [`; `ProviderSupport`→`ChannelSupport`; `providerType:`→`brand:`; local `provider.ts` files → `channel.ts` (`git mv`) with import path fixes; test files (`*_test.ts`) same renames.
- [ ] **Step 4 — disk move:** add a startup migration (host Rust, near `config::managed_data_dir` setup in `app.rs` or wherever the data root is created — find where `managed_data_dir` is first used): if `<data>/providers` doesn't exist and `<data>/plugins` exists, `fs::rename` it (whole tree: `installed`, `data`, `runtime` move together); then for each renamed ID in the map, rename `<data>/providers/data/<old-id>` → `<new-id>` and rewrite `provider.json` `"id"` inside each `installed/` dir if a stale `plugin.json` is present — actually simpler: for every dir in `providers/installed/*/`, rename `plugin.json`→`provider.json` if present, and rewrite its `"id"` field for the three renamed IDs. Write it as a small `fn migrate_legacy_plugin_dir` in the provider module with a unit test (tempdir with `plugins/data/dev.cursorbyok.examples.grok-auth/x.json` + `installed/foo/plugin.json` → assert new layout).
- [ ] **Step 5 — Deno tests:** run `$DENO test -A` for each built-in provider dir (new path). All pass.
- [ ] **Step 6 — gate:** `cargo check` (include_str paths must resolve), full cargo test suite (baseline failures only), fmt, clippy.
- [ ] **Step 7:** Commit: `"Rename the provider package format, SDK, and data directory to provider terms"` + trailer.

---

### Task 5: Desktop frontend rename

**Files:** `apps/desktop/src` (api.ts, appStore, App.tsx, AppLayout, features/plugins→providers, home/models/settings references, CallTable, demo/api.ts), `i18n` locales.

- [ ] **Step 1 — api.ts:** endpoint paths `/plugins`→`/providers` (+ `providers/{id}/channels/{id}/models/...`); types `PluginDescriptor`→`ProviderDescriptor`, `PluginModelDescriptor`→`ProviderModelDescriptor`, `PluginRuntime*`→`ProviderRuntime*`, `pluginId/pluginName`→`providerId/providerName`, inner `providerId`→`channelId`, `providerType`→`brand`, `providers` array→`channels`, `OAuth*Response`/`ImportResponse` keep names if untyped by plugin; `LlmCall`: `provider_type`→`protocol_type`, `provider_url`→`endpoint_url`, delete `request_type`/`request_url`.
- [ ] **Step 2 — files:** `git mv src/features/plugins src/features/providers`; `PluginManagementPage`→`ProviderManagementPage`, `PluginResourcePanels`→`ProviderResourcePanels` (+ `.module.scss` names); update imports everywhere.
- [ ] **Step 3 — routes/nav:** `App.tsx` `/plugins`→`/providers`; `AppLayout` menu label + icon target + "Plugins" i18n string → new `t("提供商")`?? — CHECK what the existing zh literal is (`git grep -n "插件\|Plugin" apps/desktop/src` then locales); reuse/extend as needed.
- [ ] **Step 4 — prefix checks:** every `startsWith("plugin:")`/`"plugin:"` literal in the desktop source (`HomePage` filter, `CursorModelCards`, model-select grouping, `commit` settings, `appStore`) → `"provider:"`.
- [ ] **Step 5 — CallTable:** remove `request_*` columns/fields; `provider_type`/`provider_url` → `protocol_type`/`endpoint_url`.
- [ ] **Step 6 — demo/api.ts:** mock endpoints `/plugins`→`/providers` and any mock descriptor fields.
- [ ] **Step 7 — i18n:** update zh-CN `t()` literals containing plugin terminology to provider terminology (供应商/提供方 — pick the term already used in the codebase if any exists; check `git grep -n "提供\|供应" apps/desktop/src/i18n/locales/en-US.json | head`); `npm run i18n:scan`; fill en-US + pt-BR translations for new/renamed keys; `npm run check`.
- [ ] **Step 8:** Commit: `"Rename plugins to providers across the desktop UI"` + trailer.

---

### Task 6: Docs and repo housekeeping

- [ ] **Step 1:** Update `AGENTS.md` paths (`server/plugins/build-in` → `server/providers/built-in`, `plugins/runtime` → `providers/runtime`, deno path), and any `.devin/skills`/`docs` files that reference `plugins/`, `/plugins`, `plugin.json`, `plugin:` model IDs (grep the repo docs dir; skip `docs/superpowers/specs|plans` historical docs and `.superpowers/`).
- [ ] **Step 2:** Final gate: `cargo fmt --all -- --check` (pre-existing drift only), clippy clean, `cargo test -p cursor-server --all-targets` (baseline failures only), `npm run check`, all six Deno suites green.
- [ ] **Step 3:** Commit: `"Update docs and repo guidance for the provider rename"` + trailer.

## Done Criteria

- `git grep -in "plugin" -- server apps/desktop` finds only: Tauri/Vite plugin references, migration files 0001–0011, package-lock, generated catalog, and the new migration's comments (which may keep the word in explanations).
- A migrated `~/.cursor-byok-v3` has `providers/` and no `plugins/`; historical calls show `provider:` IDs; commit model setting rewritten.
- All Deno + cargo + npm checks green (baseline exceptions aside).
