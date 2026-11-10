# UI Redesign Implementation Plan (Steps 3–6)

**Spec (authoritative):** `docs/superpowers/specs/2026-11-09-ui-redesign-design.md` — sections "Step 3" through "Step 6" and "Decisions".
**Baseline:** branch `provider-rename` → create `ui-redesign` from it.
**Sequence:** Task A (design system + shell) → Task B (Providers + Cursor) → Task C (Settings) → Task D (server support) → Task E (Overview + Calls). Sequential — same worktree, each builds on the previous.

## Hard rules for every task

- **Keep every existing feature working.** A rewrite of a page must carry over ALL functionality of the page it replaces (read the old page completely before writing the new one; list the features in the report).
- **i18n:** source literals in `t()` are English. EVERY new/changed string gets `en-US`, `pt-BR`, `zh-CN` — run `cd apps/desktop && npm run i18n:scan` then fill all three locale files, then `npm run check` must pass (missing translations fail the build).
- **Reuse, don't rebuild:** existing `shared/ui` controls (Button/Select/ModelSelect/Modal/Tooltip/message), `shared/virtual`, `shared/scrollable`, ECharts wrapper, `@floating-ui/dom` overlays, `HashRouter`, `useNavigate`, `keptAlivePages` mechanism, SCSS modules. Read `shared/ui` before inventing a control.
- **No new deps** without flagging it back to me. Prefer what `package.json` already has.
- **Graphite tokens** (Task A defines them; later tasks consume): neutral greys, thin borders, one blue accent, medium corners, dark + light themes, tabular digits (`font-variant-numeric: tabular-nums` or a mono font) for token/cost/timing numbers.
- **Gates per task:** `cd apps/desktop && npm run check` clean. If the task touches server code: `CARGO_TARGET_DIR=target/devin-test cargo check -p cursor-server --all-targets`, clippy `-D warnings`, `cargo test` (allowed failures: the 3 `prefix_stability` tests only). `cargo fmt` on touched files only — never reformat `apps/desktop/src-tauri/src/startup.rs` or `server/src/provider/oauth_callback.rs` (pre-existing drift).
- **Commits:** one commit per task, message + Devin trailer. Never stage `build-debug.bat`, `check-vc.bat`, `nul`, or anything outside the task's directories.

## Task A — design system and shell

Files: `apps/desktop/src/styles/`, `src/shell/`, `src/App.tsx`, `src/AppLayout*` (or wherever menu/top bar live), `src/shared/ui/` restyle.

- `styles/_themes.scss`: replace VS Code-named variables with Graphite tokens (surface/base/raised, text primary/secondary/muted, border, accent blue, success/warn/danger; dark + light themes via existing theme mechanism). Keep the theme-switch plumbing.
- `shell/`: `IconRail` (44px, icons + tooltips: Overview, Calls, Providers, Cursor, Settings pinned bottom; Cursor on/off + update dot become badges), `PageFrame` (fixed top bar: page title + page actions portal area + proxy status), `CommandPalette` (Ctrl+K/Cmd+K: navigate pages, providers, settings sections; virtual list + floating-ui), window chrome (existing window controls + macOS safe-area preserved).
- `App.tsx` routes: `/` (Overview), `/calls`, `/calls/:callId` (keep detail page + external-window entry), `/providers`, `/cursor`, `/settings/:section`. `PageActions` portal replaces the floating action card.
- `shared/ui`: restyle Button/Select/ModelSelect/Modal/Tooltip/inputs onto tokens — same props/behavior, new look.
- Delete `TitledCard` + menu-card styles + per-card edit-state styles (pages lose their card chrome in B/C/E — coordinate by leaving pages compiling on old styling where untouched).
- Update `.agents/skills/` frontend skill if it documents the old shell/menu.

## Task B — Providers + Cursor pages

Files: `features/providers/` (rewrite), `features/cursor/` (was `features/models/` — git mv).

- Providers: left list, two groups — Accounts (provider packages) / API keys (model groups keyed per current logic); right detail per selection. Accounts: status, quota bars, reset times, per-account refresh/remove/provider actions, bulk import/export, model list + enable switches + sync. API keys: base URL/key/headers + models with editor/presets/discovery/test (existing editor moved here). "Add provider" → kind → OAuth/import/API-key form. Runtime download becomes a top banner with progress + cancel (not a page-blocking gate).
- Cursor page (`/cursor`): certificate setup, integration on/off, Remote SSH help, model order. Model creation/editing gone from here.
- All existing providers-page + models-page functionality must survive somewhere: trace every control in the old pages to a new home.

## Task C — Settings page

Files: `features/settings/` rewrite.

- Route `/settings/:section`; second column = section list; right = active section; search filters by label+description and jumps.
- Sections: General (language, theme, startup/tray) / Network (ports, outbound proxy, external API) / Cursor (tab completion, commit model+prompt via ModelSelect single mode with "Direct" first, Headroom) / Usage & data (detailed call recording, token pricing, storage+clearing, legacy import) / About (version, update check/install).
- Save behavior: switches/dropdowns save immediately; multi-field forms keep explicit Save.
- All 12 old cards' functionality must survive — trace each one.

## Task D — server support for Overview/Calls features

Files: `server/src/` — test-first.

- Calls endpoint: server-side filtering (status, model, text search) + paging (replaces fixed `limit=200` — keep `limit` param compat for the detail/older callers if trivial, else update callers).
- Overview endpoint: per-model breakdown aggregate (grouped by model ID: tokens in/out/cache, calls, cost-share) in the same response.
- `contextWindow`: optional field on the provider SDK model descriptor (`sdk/channel.ts` + host descriptor struct + serde) — built-in providers fill it where known (Claude 200k, etc.).
- Per-model pricing: user-entered price per model, global price fallback. Extend existing pricing settings storage (find current pricing setting shape in `store/settings.rs`) — add `model_prices` map; overview cost uses per-model price when set.
- Live-call estimate for output tokens on running calls if not already exposed (check what `LlmCallSummary`/running calls carry; Calls page needs an "estimated" flag — reuse token estimator if available, else expose whatever the server has).

## Task E — Overview + Calls pages

Files: `features/overview/` (was `features/home/` — git mv), `features/calls/` rewrite, `shared/api.ts` updates for Task D endpoints.

- Overview: five tiles (tokens, cost, cache hit, calls+success rate, output speed), stacked token chart (reuse ECharts wrapper + existing daily chart data), per-model breakdown table, activity calendar (local-day — already done in step 1).
- Calls: 7 columns (time+status, model, input, cached, output, cost, duration), everything else in side panel; search/status/model filters → new server params; paging; 1s polling while visible; running rows show estimated output marked as estimate; optional conversation grouping w/ context-window meter (hidden when no `contextWindow`); CSV export (filtered calls + breakdown, in-browser).
- Full-detail page stays (`/calls/:callId`), restyled on tokens.

## Final (I do this myself)

- Whole-branch review, backup `~/.cursor-byok-v3` (db + plugins dir), rebuild, restart app, verify migration + UI boot.
