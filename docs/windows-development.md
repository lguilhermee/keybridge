# Windows source installation

This checkout lives at `D:\PROJETOS\cursor-byok`, on branch
`codex/source-pr-498`. It includes upstream PR #498 (commit
`c7114878c33076340c0c2f1e77ce4e7512d1960e`).

Local fixes recognize remote Unix absolute paths on the Windows backend and
keep automatic startup/status refresh from force-closing Cursor. An explicit
Cursor takeover retains the upstream restart behavior.

```text
apps/desktop/src/        Desktop interface; Vite reloads edits immediately.
apps/desktop/src-tauri/  Native desktop shell; Tauri rebuilds Rust edits.
server/src/             Backend and Cursor protocol implementation.
crates/semble-core/     Repository search implementation.
.vscode/tasks.json      Development and validation tasks for Cursor.
support/windows/        Windows development launcher.
```

Open the repository in Cursor:

```powershell
cursor --new-window 'D:\PROJETOS\cursor-byok'
```

Start the desktop app from source:

```powershell
npm --prefix 'D:\PROJETOS\cursor-byok\apps\desktop' run tauri:dev
```

Alternatively, run **Terminal > Run Task > Cursor BYOK: desktop development**
in Cursor. Exit the currently running Cursor BYOK app from its tray menu before
starting another development session. Closing its window leaves the tray app
running.

For a standalone app, including Windows autostart, build the embedded frontend:

```powershell
npm --prefix 'D:\PROJETOS\cursor-byok\apps\desktop' run tauri:build -- --debug --no-bundle
& 'D:\PROJETOS\cursor-byok\target\debug\cursor-byok-desktop.exe'
```

Standalone Cargo builds also embed the frontend by default; run `npm run build`
in `apps/desktop` first to generate the assets. `tauri dev` disables that default
and proxies the UI to Vite on `127.0.0.1:1420`. Its executable requires the
development session to remain running. Rebuild the standalone app after a
development session before using that executable directly or through autostart.

The Desktop and Start Menu **Cursor BYOK** shortcuts use
`support/windows/start-dev.ps1`. They start development mode with a hidden
terminal and write build output to `target/windows-dev.log`. The app reads the
existing settings, database, providers and certificates in
`C:\Users\Administrador\.cursor-byok-v3`. The old packaged installer is removed;
no release installer is needed to run this checkout.

The launcher reopens an existing source app and refuses to use port 1420 when
another process owns it. Do not install an upstream automatic update over a
custom source build; update Git, review changes, and rebuild instead.

Validate changes:

```powershell
npm --prefix 'D:\PROJETOS\cursor-byok\apps\desktop' run check
Set-Location 'D:\PROJETOS\cursor-byok'
cargo test --locked -p cursor-server --lib
cargo test --locked -p cursor-server --test tool_round --test interrupt --test connect_wire
cargo fmt --all -- --check
```

For Remote SSH, follow [the PR's verification checklist](remote-ssh.md).
Set `"cursorAgentHost.remoteInferenceRoute": "always"` in the specific
**Remote [SSH: host]** settings, reload that window, and select a BYOK model.
Local build and startup checks do not verify a remote SSH session.

## Installation verification on 2026-10-12

- `npm ci` and `npm run check` passed in `apps/desktop`.
- `cargo test --locked -p cursor-server --lib --test tool_round --test interrupt --test connect_wire`: 226 passed.
- `cargo test --locked -p semble-core --lib`: 37 passed.
- `cargo fmt --all -- --check` passed for the installation changes.
- `npm run tauri:build -- --debug --no-bundle` built the desktop application.
- The running desktop executable is from this checkout's `target/debug` folder.
  Vite serves development assets on loopback port 1420; the desktop API uses
  the preserved service port 50821 and proxy port 53408.
- Health returned HTTP 204, the existing CA remained ready, and local
  integration reported enabled with settings applied.
- The live interface displayed the Remote SSH guide and its `always` setting.
  Screenshot: `target/remote-ssh-guide.png`.
- Database integrity was `ok`; the existing 2 conversations, 545 messages,
  6 runs, and both CA files were preserved. A complete data/settings backup
  is in `C:\Users\Administrador\.cursor-byok-backups\20261012-source-install-185857`.
- The packaged executable, uninstall registration and downloaded 1.0.1
  installer were removed. Desktop/Start Menu shortcuts point to this source
  launcher; **Cursor BYOK Source** opens this checkout in Cursor.
- No live Remote SSH chat or provider request was performed. Separate plugin
  edits appeared during setup and were left uncommitted; the test counts above
  describe the installation changes before those edits.
