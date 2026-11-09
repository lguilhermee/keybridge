<div align="center">

# Keybridge

A local model gateway for Cursor — bring your own keys, keep the agent.

</div>

## About

Keybridge runs a service on your machine that connects Cursor to the model APIs
you configure. It routes model requests through your own providers and preserves
Cursor Agent capabilities such as tool calling, Skills, and MCP — so the agent
keeps working, but every token is billed to the provider and key you choose.

You can connect OpenAI- and Anthropic-compatible APIs, customize endpoints,
model IDs, API keys, and request parameters, and sign in to subscription-based
providers through the built-in auth plugins.

> [!IMPORTANT]
> Keybridge is free and open source, but the model APIs you connect may charge
> for usage. This is an independent project and is not affiliated with or
> endorsed by Cursor or its developers.

## Features

- **Bring your own model channels:** configure your own API endpoint, credentials, and model IDs.
- **Multiple API protocols:** OpenAI- and Anthropic-compatible APIs, or a custom endpoint.
- **Subscription providers:** built-in plugins for Claude, Codex, Devin, Grok, OpenCode, and Antigravity accounts.
- **Model management:** add, duplicate, edit, reorder, and batch-test model configurations.
- **Connection benchmarks:** measure time to first token, generation speed, and inspect raw provider responses.
- **Agent workflows:** tool calling, Skills, MCP, and multi-turn conversations keep working.
- **Session metrics:** token usage, cache hit rate, conversation turns, and estimated value.
- **Cross-platform:** macOS, Windows, and Linux.

## How It Works

```text
Cursor client
    │
    │  Agent requests and tool results
    ▼
Keybridge local service
    │
    │  OpenAI- / Anthropic-compatible requests
    ▼
Your model API
```

Keybridge handles protocol adaptation, model request forwarding, tool-call
coordination, and conversation state on your machine. API keys and application
settings are stored locally; requests are sent only to the provider you
configure.

## Quick Start

Prerequisites: a Rust toolchain (MSVC on Windows) and Node.js. On Windows,
NASM must be on your `PATH` (required by `aws-lc-sys`).

```bash
# install desktop dependencies
npm --prefix apps/desktop install

# run the desktop app in development
npm --prefix apps/desktop run tauri:dev

# or build a release installer (NSIS; a local Tauri signing key is generated automatically)
make build-web build-desktop
```

To run only the backend service:

```bash
cargo build --release -p cursor-server --bin cursor-server
```

## Project Layout

```text
apps/desktop/            Tauri + React desktop app (dashboard, model and plugin management)
server/                  Rust backend: Cursor protocol, agent transport, provider adapters
server/plugins/build-in/ Built-in provider plugins (Claude, Codex, Devin, Grok, OpenCode, Antigravity)
crates/semble-core/      Repository search implementation
docs/                    Development and platform notes
```

## Development

```bash
cargo fmt --all -- --check
cargo clippy -p cursor-server --all-targets -- -D warnings
cargo test -p cursor-server --all-targets
```

Built-in plugins are tested with the bundled Deno runtime:

```bash
deno test -A <plugin>_test.ts
```

Issues and pull requests are welcome.

## License

This project is open source under the [MIT License](./LICENSE).

## Credits

Keybridge is based on [cursor-byok](https://github.com/leookun/cursor-byok) by
[@leookun](https://github.com/leookun) — the local Cursor backend protocol
implementation, the desktop app, and the plugin system all originate in that
project. Thank you for building it and releasing it as open source.
