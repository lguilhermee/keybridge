//! One-time move of the pre-rename `plugins/` data tree to `providers/`.
use std::path::{Path, PathBuf};

use crate::{config, Result};

/// Provider ids whose namespace changed in the rename; installed manifests and
/// `data/<id>` directories are rewritten to the new spelling.
const RENAMED_IDS: [(&str, &str); 3] = [
    (
        "dev.cursorbyok.plugins.antigravity-auth",
        "dev.cursorbyok.providers.antigravity-auth",
    ),
    (
        "dev.cursorbyok.examples.codex-auth",
        "dev.cursorbyok.providers.codex-auth",
    ),
    (
        "dev.cursorbyok.examples.grok-auth",
        "dev.cursorbyok.providers.grok-auth",
    ),
];

/// Runs before any provider directory is created: renames `<managed>/plugins`
/// to `<managed>/providers` when the new tree is absent, then fixes up stale
/// manifest file names, renamed ids, and `data/<id>` directories.
pub(crate) fn migrate_legacy_plugin_dir() -> Result<()> {
    migrate_legacy_plugin_dir_in(&config::managed_data_dir()?)
}

fn migrate_legacy_plugin_dir_in(managed: &Path) -> Result<()> {
    let legacy = managed.join("plugins");
    let providers = managed.join("providers");
    if !providers.exists() && legacy.is_dir() {
        std::fs::rename(&legacy, &providers)?;
        tracing::info!(path = %providers.display(), "migrated plugins data directory to providers");
    }
    if !providers.is_dir() {
        return Ok(());
    }
    migrate_installed_manifests(&providers.join("installed"));
    migrate_data_dirs(&providers.join("data"));
    Ok(())
}

/// Renames `plugin.json` to `provider.json` in every installed provider and
/// rewrites manifests that still carry a renamed id.
fn migrate_installed_manifests(installed: &Path) {
    let entries = match std::fs::read_dir(installed) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let legacy = directory.join("plugin.json");
        let manifest = directory.join("provider.json");
        if legacy.is_file() {
            if manifest.exists() {
                let _ = std::fs::remove_file(&legacy);
            } else if let Err(error) = std::fs::rename(&legacy, &manifest) {
                tracing::warn!(path = %legacy.display(), %error, "failed to rename legacy provider manifest");
                continue;
            }
        }
        rewrite_manifest_id(&manifest);
    }
}

fn rewrite_manifest_id(manifest: &Path) {
    let Ok(content) = std::fs::read_to_string(manifest) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(id) = value.get("id").and_then(serde_json::Value::as_str) else {
        return;
    };
    let Some((_, new_id)) = RENAMED_IDS.iter().find(|(old, _)| *old == id) else {
        return;
    };
    value["id"] = serde_json::Value::String((*new_id).to_owned());
    match serde_json::to_string_pretty(&value) {
        Ok(content) => {
            if let Err(error) = std::fs::write(manifest, content) {
                tracing::warn!(path = %manifest.display(), %error, "failed to rewrite provider id in manifest");
            }
        }
        Err(error) => {
            tracing::warn!(path = %manifest.display(), %error, "failed to serialize migrated provider manifest");
        }
    }
}

/// Renames `data/<old-id>` directories to the new provider id.
fn migrate_data_dirs(data: &Path) {
    for (old, new) in RENAMED_IDS {
        let (from, to): (PathBuf, PathBuf) = (data.join(old), data.join(new));
        if from.is_dir() && !to.exists() {
            if let Err(error) = std::fs::rename(&from, &to) {
                tracing::warn!(path = %from.display(), %error, "failed to rename provider data directory");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_legacy_tree_and_rewrites_renamed_ids() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path();

        let legacy_data = managed.join("plugins/data/dev.cursorbyok.examples.grok-auth");
        std::fs::create_dir_all(&legacy_data).unwrap();
        std::fs::write(legacy_data.join("state.json"), "{}").unwrap();
        let legacy_runtime = managed.join("plugins/runtime/deno");
        std::fs::create_dir_all(&legacy_runtime).unwrap();
        std::fs::write(legacy_runtime.join("marker"), "x").unwrap();
        let installed = managed.join("plugins/installed/grok-auth");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(
            installed.join("plugin.json"),
            r#"{"apiVersion":1,"id":"dev.cursorbyok.examples.grok-auth","name":"Grok","version":"0.1.7","icon":"assets/grok.svg","entry":"main.ts"}"#,
        )
        .unwrap();
        let untouched = managed.join("plugins/installed/claude-auth");
        std::fs::create_dir_all(&untouched).unwrap();
        std::fs::write(
            untouched.join("plugin.json"),
            r#"{"apiVersion":1,"id":"dev.cursorbyok.providers.claude","name":"Claude","version":"0.1.5","icon":"assets/claude.svg","entry":"main.ts"}"#,
        )
        .unwrap();

        migrate_legacy_plugin_dir_in(managed).unwrap();

        assert!(!managed.join("plugins").exists());
        let providers = managed.join("providers");
        assert!(providers.join("runtime/deno/marker").is_file());
        assert!(providers
            .join("data/dev.cursorbyok.providers.grok-auth/state.json")
            .is_file());
        assert!(!providers
            .join("data/dev.cursorbyok.examples.grok-auth")
            .exists());

        let grok: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(providers.join("installed/grok-auth/provider.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(grok["id"], "dev.cursorbyok.providers.grok-auth");
        assert!(!providers.join("installed/grok-auth/plugin.json").exists());

        let claude: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(providers.join("installed/claude-auth/provider.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claude["id"], "dev.cursorbyok.providers.claude");
    }

    #[test]
    fn no_op_when_providers_tree_already_exists() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path();
        std::fs::create_dir_all(managed.join("providers/installed")).unwrap();
        std::fs::create_dir_all(managed.join("plugins/data")).unwrap();

        migrate_legacy_plugin_dir_in(managed).unwrap();

        assert!(managed.join("plugins/data").is_dir());
    }
}
