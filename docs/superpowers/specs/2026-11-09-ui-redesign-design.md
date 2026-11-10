# Desktop UI redesign, provider rename, and token accuracy: overall design

Date: 2026-11-09
Status: approved in conversation, awaiting review of this document

This is the overall design. It fixes the decisions and the order of work. Each
step below gets its own spec and implementation plan before it is built.

## Goal

Rebuild the desktop UI with a new shell, visual language, Providers page, and
Settings page; rename "plugin" to "provider" through the whole codebase; make
token numbers correct and more useful. Every existing feature is kept.

## Decisions

| Topic | Decision |
|---|---|
| Stack | Unchanged: React, SCSS modules, Tauri, HashRouter, `/__byok-api__/api`, static i18n catalog |
| Shell | 44px icon rail with tooltips; Settings pinned at the bottom; one fixed top bar holding page title, page actions, and proxy status |
| Visual style | "Graphite": neutral greys, thin borders, one blue accent, medium corners; dark and light themes; tabular monospace digits for token, cost, and timing numbers |
| Settings | Section list plus one section at a time, with search |
| Settings saving | Switches and dropdowns save immediately; multi-field forms (ports, outbound proxy, pricing, commit prompt) keep an explicit Save |
| Providers page | One page for both signed-in account providers and API-key endpoints; list on the left, detail on the right |
| Rename depth | Everything: Rust modules, SDK, management API, stored IDs, on-disk folders |
| Naming | plugin → provider; a plugin's inner provider → channel; `server/src/provider` → `server/src/protocol` |
| Existing data | Moved once at first start. This is a deliberate exception to the "no migrations" rule in `AGENTS.md` |
| New features | All seven listed under step 6 |

## Order of work

Each step ends with a working product.

| # | Step | Scope |
|---|---|---|
| 1 | Token accuracy fixes | Server, built-in providers' usage reporting |
| 2 | Rename | Server, SDK, built-in packages, management API, frontend types, data move |
| 3 | Design system and shell | `styles/`, `shell/`, `shared/ui/` |
| 4 | Providers page and slimmed Cursor page | `features/providers`, `features/cursor` |
| 5 | Settings page | `features/settings` |
| 6 | Overview, Calls, and new features | `features/overview`, `features/calls`, supporting server endpoints |

## Step 1: token accuracy

Problems found by reading the code (not reproduced by running it):

1. Built-in providers disagree on `inputTokens`. `claude-auth` reports
   non-cached input only (`claude-auth/request.ts`, `mergeUsage`); `devin-auth`
   adds cache tokens into it; OpenAI-style ones include cached tokens.
   `plugin/wire.rs` copies `inputTokens` into `context_input_tokens` for all of
   them. For Claude accounts the context anchor used by auto-compaction is
   therefore the non-cached part only.
2. `store/overview.rs` `fresh_input_sql` subtracts cache tokens from input for
   every request type except `anthropic`, including `plugin`. For Claude
   accounts non-cached input clamps to zero, so totals and cost are too low.
3. `model/token_count.rs` estimates tokens as characters ÷ 4.
4. Day buckets are cut in UTC while the "Today" preset uses local midnight.

Design:

- `Usage.input_tokens` means non-cached input for every source.
  `Usage.context_input_tokens` means input + cache read + cache write.
- Each protocol adapter and each built-in provider converts to that meaning at
  its own edge. The SDK documents `inputTokens` as non-cached input.
- `plugin/wire.rs` computes `context_input_tokens` from the three parts instead
  of copying `inputTokens`.
- `fresh_input_sql` is deleted; the overview sums `input_tokens` directly.
- A SQL migration normalises existing `llm_calls` rows. The stored provider URL
  identifies which convention a row used.
- The overview endpoint accepts a UTC offset in minutes and cuts buckets at
  local boundaries. The activity calendar uses the same offset.
- `bpe-openai` (`o200k_base`) replaces the character estimate. It was chosen
  over `tiktoken-rs` because tiktoken's merge step is super-linear on
  whitespace-free text (~6.9 s vs ~0.7 s on an unbroken 4 MB string in a debug
  build) at identical counts. For models without a public local tokenizer
  (Claude, Gemini) the result is still an approximation, so the 10% context
  reserve in `run/compaction.rs` stays.

Tests are written first: one per adapter and built-in provider asserting the
normalised `Usage`, one for the overview totals with mixed sources, one for
local-day bucketing, one for the row migration.

## Step 2: rename

```
server/
├── src/
│   ├── protocol/              # was provider/  wire-format adapters and the call trait
│   └── provider/              # was plugin/    registry, worker, runtime, catalog, state
│       └── sdk/
│           ├── provider.ts    # was plugin.ts    defineProvider({ channels, resources })
│           └── channel.ts     # was provider.ts  one model source inside a provider
└── providers/built-in/        # was plugins/build-in/
    └── <name>/provider.json   # was plugin.json
```

| Thing | Before | After |
|---|---|---|
| Management API | `/plugins/...` | `/providers/...` |
| Stored model ID | `plugin:<plugin>/<provider>/<model>` | `provider:<provider>/<channel>/<model>` |
| Protocol enum | `ProviderType` with `Plugin` | `ProtocolType` with `Provider` |
| `llm_calls` columns | `provider_type`, `provider_url` | `protocol_type`, `endpoint_url` |
| Call URL scheme | `plugin://<id>/<provider>` | `provider://<id>/<channel>` |
| Data folder | `~/.cursor-byok-v3/plugins/` | `~/.cursor-byok-v3/providers/` |
| Frontend types | `Plugin*` | `Provider*`, `Channel*` |

One-time data move, run at startup before the registry loads:

- Rename the data folder if the old one exists and the new one does not.
- One SQL migration rewrites stored model IDs, `'plugin'` enum values, call URL
  schemes, and the commit model setting, and renames the two columns.

No runtime fallback reads the old names after the move.

Provider packages written against the current SDK stop loading. The six
built-in ones are updated. No third-party packages are assumed to exist.

UI wording: Provider, Account, Model. "Channel" is shown only for a provider
with more than one (today, OpenCode).

`AGENTS.md` and the project skills that mention plugin paths are updated in the
same step.

## Step 3: design system and shell

```
apps/desktop/src/
├── App.tsx              # routes: /  /calls  /providers  /cursor  /settings/:section
├── shell/               # IconRail, PageFrame (title + actions bar), CommandPalette, window chrome
├── features/
│   ├── overview/        # was home/
│   ├── calls/
│   ├── providers/       # was plugins/ plus the model editor from models/
│   ├── cursor/          # was models/
│   └── settings/
│       └── sections/    # General, Network, Cursor, UsageData, About
├── shared/ui/           # controls restyled on the new tokens
└── styles/              # Graphite tokens, dark and light, typography scale
```

- Design tokens replace the VS Code-named variables in `styles/_themes.scss`.
- `PageFrame` replaces the floating action card; `PageActions` keeps portalling
  page controls into the top bar.
- The icon rail replaces the menu card. The Cursor "local on/off" tag and the
  update dot become badges on rail icons.
- Command palette (Ctrl+K / Cmd+K): pages, providers, models, settings
  sections. Built on the existing floating-ui and virtual list pieces.
- Kept: virtual scrolling, `ModelSelect`, ECharts wrapper, tooltip, message
  toasts, window-control and macOS safe-area handling.
- Deleted: `TitledCard`, the menu card styles, per-card edit-state styles.

The project `frontend` skill's routing and page-layout rules are updated to
match the new shell in this step.

## Step 4: Providers and Cursor pages

Providers:

- Left list with two groups: Accounts (provider packages) and API keys (model
  groups, keyed by group name or host as `modelProviderName` does today).
- Right detail for an account provider: accounts with status, quota bars, and
  reset times; per-account refresh, remove, and provider-defined actions; bulk
  import and export; model list with enable switches and sync.
- Right detail for an API-key provider: base URL, key, headers, and its models,
  each opening the existing model editor, presets, discovery, and test.
- "Add provider" asks for the kind, then runs the OAuth, import, or API-key
  form.
- The runtime download is a banner at the top of the page with progress and
  cancel, not a page-blocking gate.

Cursor:

- Certificate setup, integration on/off, Remote SSH help, and model order.
  Model creation and editing no longer live here.

## Step 5: Settings

| Section | Contents |
|---|---|
| General | Language, theme, startup and tray (silent start, dock icon, autostart) |
| Network | Ports, outbound proxy, external API |
| Cursor | Tab completion service, commit message model and prompt, Headroom |
| Usage & data | Detailed call recording, token pricing, storage and clearing, legacy import |
| About | Version, update check and install |

- Route `/settings/:section`; the section list is a second column.
- Search filters settings by label and description and jumps to the match.
- The commit model keeps using `ModelSelect` in single mode with "Direct" first.

## Step 6: Overview, Calls, and new features

Overview: five tiles (tokens, cost, cache hit, calls with success rate, output
speed), stacked token chart, per-model breakdown table, activity calendar.

Calls: seven columns (time and status, model, input, cached, output, cost,
duration); everything else in a side panel; the full-detail browser page stays.

| # | Feature | Notes |
|---|---|---|
| 1 | Per-model and per-provider breakdown | New aggregate in the overview endpoint, grouped by model ID |
| 2 | Per-model pricing | Price per model with the global price as fallback; entered by the user, nothing shipped or fetched |
| 3 | Context-window meter and conversation grouping | Meter = latest `context_input_tokens` ÷ the model's context window. The provider SDK model descriptor gains an optional `contextWindow`; the built-in providers fill it in. The meter is hidden for models without one |
| 4 | Live calls | The Calls page polls once a second while visible. A running call shows the server's estimated output count, marked as estimated, until the provider reports usage |
| 5 | Real tokenizer | Delivered in step 1 |
| 6 | Command palette | Delivered in step 3 |
| 7 | CSV export | Filtered calls and the per-model breakdown, generated in the browser |

Calls gains server-side filtering (status, model, text search) and paging,
replacing the fixed `limit=200`.

## Cross-cutting

- i18n: source strings are written in English, matching the current code. Every
  new string gets `en-US`, `pt-BR`, and `zh-CN` entries; the build fails on a
  missing one.
- Verification per step: `cargo fmt --all -- --check`,
  `cargo clippy -p cursor-server --all-targets -- -D warnings`,
  `cargo test -p cursor-server --all-targets`, `deno test -A` in each built-in
  provider directory, and `npm run check` in `apps/desktop`.
- Server changes are test-first.

## Out of scope

- Changing the frontend framework or replacing SCSS modules.
- Shipping or fetching model price lists.
- A provider marketplace or installing third-party provider packages from the UI.
- Changes to the Cursor protocol, prompt projection, or checkpoint logic beyond
  the token estimate used for compaction.
