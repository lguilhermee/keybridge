//! Pre-installs bundled built-in providers into the user's installed directory.
use std::path::Path;

use super::definition::write_if_changed;
use crate::Result;

/// Built-in provider files packaged into the binary; release builds have no source directory, so they are preinstalled from here.
const CODEX_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/provider.json"
        )),
    ),
    (
        "main.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/main.ts"
        )),
    ),
    (
        "channel.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/channel.ts"
        )),
    ),
    (
        "models.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/models.ts"
        )),
    ),
    (
        "oauth.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/oauth.ts"
        )),
    ),
    (
        "resources.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/resources.ts"
        )),
    ),
    (
        "assets/codex.svg",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/codex-auth/assets/codex.svg"
        )),
    ),
];

const GROK_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/provider.json"
        )),
    ),
    (
        "main.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/main.ts"
        )),
    ),
    (
        "channel.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/channel.ts"
        )),
    ),
    (
        "models.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/models.ts"
        )),
    ),
    (
        "oauth.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/oauth.ts"
        )),
    ),
    (
        "resources.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/resources.ts"
        )),
    ),
    (
        "assets/grok.svg",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/grok-auth/assets/grok.svg"
        )),
    ),
];

const ANTIGRAVITY_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/provider.json"
        )),
    ),
    (
        "main.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/main.ts"
        )),
    ),
    (
        "channel.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/channel.ts"
        )),
    ),
    (
        "models.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/models.ts"
        )),
    ),
    (
        "oauth.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/oauth.ts"
        )),
    ),
    (
        "google_oauth.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/google_oauth.ts"
        )),
    ),
    (
        "resources.ts",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/resources.ts"
        )),
    ),
    (
        "assets/antigravity.svg",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/providers/built-in/antigravity-auth/assets/antigravity.svg"
        )),
    ),
];

const DEVIN_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!("../../providers/built-in/devin-auth/provider.json"),
    ),
    (
        "main.ts",
        include_str!("../../providers/built-in/devin-auth/main.ts"),
    ),
    (
        "connect.ts",
        include_str!("../../providers/built-in/devin-auth/connect.ts"),
    ),
    (
        "resources.ts",
        include_str!("../../providers/built-in/devin-auth/resources.ts"),
    ),
    (
        "models.ts",
        include_str!("../../providers/built-in/devin-auth/models.ts"),
    ),
    (
        "request.ts",
        include_str!("../../providers/built-in/devin-auth/request.ts"),
    ),
    (
        "channel.ts",
        include_str!("../../providers/built-in/devin-auth/channel.ts"),
    ),
    (
        "README.md",
        include_str!("../../providers/built-in/devin-auth/README.md"),
    ),
    (
        "NOTICE",
        include_str!("../../providers/built-in/devin-auth/NOTICE"),
    ),
    (
        "assets/devin.svg",
        include_str!("../../providers/built-in/devin-auth/assets/devin.svg"),
    ),
];

const CLAUDE_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!("../../providers/built-in/claude-auth/provider.json"),
    ),
    (
        "main.ts",
        include_str!("../../providers/built-in/claude-auth/main.ts"),
    ),
    (
        "resources.ts",
        include_str!("../../providers/built-in/claude-auth/resources.ts"),
    ),
    (
        "models.ts",
        include_str!("../../providers/built-in/claude-auth/models.ts"),
    ),
    (
        "request.ts",
        include_str!("../../providers/built-in/claude-auth/request.ts"),
    ),
    (
        "channel.ts",
        include_str!("../../providers/built-in/claude-auth/channel.ts"),
    ),
    (
        "assets/claude.svg",
        include_str!("../../providers/built-in/claude-auth/assets/claude.svg"),
    ),
];

const OPENCODE_AUTH: &[(&str, &str)] = &[
    (
        "provider.json",
        include_str!("../../providers/built-in/opencode-auth/provider.json"),
    ),
    (
        "main.ts",
        include_str!("../../providers/built-in/opencode-auth/main.ts"),
    ),
    (
        "free.ts",
        include_str!("../../providers/built-in/opencode-auth/free.ts"),
    ),
    (
        "resources.ts",
        include_str!("../../providers/built-in/opencode-auth/resources.ts"),
    ),
    (
        "models.ts",
        include_str!("../../providers/built-in/opencode-auth/models.ts"),
    ),
    (
        "channel.ts",
        include_str!("../../providers/built-in/opencode-auth/channel.ts"),
    ),
    (
        "assets/opencode.svg",
        include_str!("../../providers/built-in/opencode-auth/assets/opencode.svg"),
    ),
];

const PROVIDERS: &[(&str, &[(&str, &str)])] = &[
    ("codex-auth", CODEX_AUTH),
    ("grok-auth", GROK_AUTH),
    ("antigravity-auth", ANTIGRAVITY_AUTH),
    ("devin-auth", DEVIN_AUTH),
    ("claude-auth", CLAUDE_AUTH),
    ("opencode-auth", OPENCODE_AUTH),
];

/// Syncs built-in providers into the installed directory on every start. The binary owns these
/// directories: file content is compared byte-for-byte, so unchanged files cost no writes, changed
/// files are replaced, and files absent from the embedded bundle are removed.
pub(super) fn install(installed: &Path) -> Result<()> {
    for (name, files) in PROVIDERS {
        write_provider(&installed.join(name), files)?;
    }
    Ok(())
}

fn write_provider(directory: &Path, files: &[(&str, &str)]) -> Result<()> {
    for (relative, content) in files {
        let path = directory.join(relative);
        let parent = path.parent().expect("provider file path has a parent");
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        write_if_changed(&path, content)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    prune_unknown_files(directory, directory, files)?;
    Ok(())
}

/// Removes files and empty directories from the provider directory that are not in the embedded manifest (leftovers from older versions).
fn prune_unknown_files(root: &Path, directory: &Path, files: &[(&str, &str)]) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            prune_unknown_files(root, &path, files)?;
            if std::fs::read_dir(&path)?.next().is_none() {
                std::fs::remove_dir(&path)?;
            }
            continue;
        }
        let known = files
            .iter()
            .any(|(relative, _)| root.join(relative) == path);
        if !known {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedded_main() -> &'static str {
        CODEX_AUTH
            .iter()
            .find(|(name, _)| *name == "main.ts")
            .unwrap()
            .1
    }

    #[test]
    fn install_syncs_content_even_when_version_is_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let provider = root.path().join("codex-auth");

        install(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(provider.join("main.ts")).unwrap(),
            embedded_main()
        );
        assert!(root
            .path()
            .join("antigravity-auth/assets/antigravity.svg")
            .is_file());
        assert!(root.path().join("devin-auth/channel.ts").is_file());

        // Same manifest version, stale content on disk (an older build shipped different code
        // without bumping the version): content is restored and leftovers are removed.
        std::fs::write(provider.join("main.ts"), "stale").unwrap();
        std::fs::write(provider.join("stale.ts"), "extra").unwrap();
        install(root.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(provider.join("main.ts")).unwrap(),
            embedded_main()
        );
        assert!(!provider.join("stale.ts").exists());
    }
}
