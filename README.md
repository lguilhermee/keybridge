<div align="center">

<img src="./docs/keybridge-logo.png" alt="Keybridge" width="440" />

**Your models. Your subscriptions. In Cursor and Codex.**

Keybridge is a desktop app that connects your AI accounts, API keys, and local models to the coding tools you already use. Pick a model and keep working in your editor.

**[Download for Windows, macOS, or Linux](https://github.com/lguilhermee/keybridge/releases/latest)** · [Report an issue](https://github.com/lguilhermee/keybridge/issues) · [MIT license](./LICENSE)

</div>

## What you get

- **Cursor integration** — use your models with Agent, Plan, Debug, file edits, terminal commands, MCP, subagents, and Computer Use.
- **Codex app and CLI integration** — use the same configured models, with reasoning effort and Fast options where supported.
- **Token-saving tools** — optional Headroom integration compresses request context to reduce input tokens. Cache-friendly conversation history also helps reuse provider prompt caches. Install and enable Headroom in **Settings → Cursor → Headroom**.
- **Model combos** — put several models under one name. Start in order, rotate, or choose randomly; switch to the next model on errors, rate limits, or refusals.
- **Refusal switching** — choose a replacement model for individual models, with bulk editing for larger lists.
- **Usage you can inspect** — see tokens, estimated costs, cache hits, and response times. Filter calls, export CSV, or enable detailed request and response recording.
- **A local API for other apps** — share your configured models through OpenAI- or Anthropic-compatible endpoints.

## Bring what you already have

**Accounts:** Claude, ChatGPT / Codex, Devin / Windsurf, Google Antigravity, Grok, and OpenCode. Sign-in and import options vary by provider.

**API keys:** OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages endpoints, including compatible services such as OpenRouter and DeepSeek.

**Local models:** Ollama, vLLM, LM Studio, or another server with a compatible API.

Available models and usage limits depend on the provider and your account.

## Get started

1. [Download the latest release](https://github.com/lguilhermee/keybridge/releases/latest) and open Keybridge.
2. Open **Providers → Add provider**. Sign in to an account or add an API endpoint and its models.
3. Connect your coding tool:
   - **Cursor:** open the **Cursor** page, click **Initialize CA**, follow the certificate trust prompts, and enable **local Cursor integration**.
   - **Codex:** open the **Codex** page, turn on **Connect Codex**, then restart Codex to load the model list.
4. Keep Keybridge running and choose your model in Cursor or Codex.

Cursor connects through a local HTTPS proxy using a certificate you trust during setup. Codex connects through the local API; its previous model settings are restored when you disconnect or Keybridge shuts down. Requests go to the model provider you choose.

Codex's built-in web search is unavailable with Keybridge models. For Cursor Remote SSH setup and current verification limits, see the [Remote SSH guide](./docs/remote-ssh.md).

## Build from source

You'll need Rust and Node.js 20+, plus the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows also needs `nasm` on `PATH`.

Run from the repository root:

```bash
npm --prefix apps/desktop install
npm --prefix apps/desktop run tauri:dev
```

To build the desktop app:

```bash
npm --prefix apps/desktop run tauri:build
```

<details>
<summary>Development checks</summary>

```bash
cargo fmt --all -- --check
cargo clippy -p cursor-server --all-targets -- -D warnings
cargo test -p cursor-server --all-targets
npm --prefix apps/desktop run check
```

For built-in providers, run `deno test -A <provider>_test.ts` from that provider's directory under `server/providers/built-in/`.

</details>

---

Free and open source under [MIT](./LICENSE). Provider fees and limits still apply. Keybridge is an independent project, unaffiliated with Cursor or the model providers.

Built on [cursor-byok](https://github.com/leookun/cursor-byok) by [@leookun](https://github.com/leookun).
