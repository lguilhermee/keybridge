//! Discovers provider manifests and evaluates serializable TypeScript definitions.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

use super::{
    definition::ProviderDefinitionLoader,
    descriptor::ProviderModuleDefinition,
    manifest::{validate_id, ProviderManifest},
};
use crate::{config, Error, Result};

const MANIFEST_FILE_NAME: &str = "provider.json";
const MAX_ICON_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct ProviderCatalog {
    roots: Vec<PathBuf>,
    definition_loader: ProviderDefinitionLoader,
    app_version: String,
}

#[derive(Clone)]
pub(crate) struct ProviderEntry {
    pub directory: PathBuf,
    pub entry: PathBuf,
    pub manifest: ProviderManifest,
    pub definition: ProviderModuleDefinition,
    pub icon: String,
    /// Hash of every file in the provider directory; a stored model catalog synced by different
    /// provider code is stale (the provider may now declare other models or picker options).
    pub source_hash: String,
}

impl ProviderCatalog {
    pub fn managed(app_version: String) -> Result<Self> {
        let installed = config::managed_data_dir()?.join("providers/installed");
        fs::create_dir_all(&installed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&installed, fs::Permissions::from_mode(0o700))?;
        }
        // Built-in providers are synced from the embedded bundle; unchanged files are not rewritten.
        super::builtin::install(&installed)?;
        // Scan order is priority: in debug the source directory comes first so built-in provider edits take effect hot;
        // release builds only have the installed root.
        #[cfg(debug_assertions)]
        let roots = vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("providers/built-in"),
            installed,
        ];
        #[cfg(not(debug_assertions))]
        let roots = vec![installed];
        Ok(Self {
            roots,
            definition_loader: ProviderDefinitionLoader::managed()?,
            app_version,
        })
    }

    pub(crate) fn loader(&self) -> &ProviderDefinitionLoader {
        &self.definition_loader
    }

    pub(crate) async fn entries(&self, executable: &Path) -> Vec<ProviderEntry> {
        let mut providers = BTreeMap::new();
        for root in &self.roots {
            let mut directories = match child_directories(root) {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(path = %root.display(), %error, "failed to scan provider directory");
                    continue;
                }
            };
            directories.sort();
            for directory in directories {
                match load_provider(
                    &directory,
                    &self.definition_loader,
                    executable,
                    &self.app_version,
                )
                .await
                {
                    Ok(entry) => {
                        if providers.contains_key(&entry.manifest.id) {
                            tracing::warn!(provider = %entry.manifest.id, path = %directory.display(), "ignoring duplicate provider");
                        } else {
                            providers.insert(entry.manifest.id.clone(), entry);
                        }
                    }
                    Err(error) => {
                        tracing::warn!(path = %directory.display(), %error, "ignoring invalid provider")
                    }
                }
            }
        }
        providers.into_values().collect()
    }

    pub(crate) fn manifests(&self) -> Vec<(ProviderManifest, String)> {
        let mut providers = BTreeMap::new();
        for root in &self.roots {
            let Ok(mut directories) = child_directories(root) else {
                continue;
            };
            directories.sort();
            for directory in directories {
                let loaded = (|| -> Result<_> {
                    let manifest: ProviderManifest =
                        serde_json::from_slice(&fs::read(directory.join(MANIFEST_FILE_NAME))?)?;
                    manifest.validate(&directory)?;
                    require_app_version(&manifest, &self.app_version)?;
                    let icon = icon_data_url(&directory, &manifest.icon)?;
                    Ok((manifest, icon))
                })();
                if let Ok((manifest, icon)) = loaded {
                    providers
                        .entry(manifest.id.clone())
                        .or_insert((manifest, icon));
                }
            }
        }
        providers.into_values().collect()
    }
}

fn child_directories(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut directories = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            directories.push(entry.path());
        }
    }
    Ok(directories)
}

/// Refuses to load when the app is too old, honoring the provider's minAppVersion declaration.
fn require_app_version(manifest: &ProviderManifest, app_version: &str) -> Result<()> {
    let Some(minimum) = &manifest.min_app_version else {
        return Ok(());
    };
    if super::manifest::version_at_least(app_version, minimum) {
        return Ok(());
    }
    Err(Error::Config(format!(
        "provider '{}' requires app version {minimum} or newer (current {app_version})",
        manifest.id
    )))
}

async fn load_provider(
    directory: &Path,
    loader: &ProviderDefinitionLoader,
    executable: &Path,
    app_version: &str,
) -> Result<ProviderEntry> {
    let manifest: ProviderManifest =
        serde_json::from_slice(&fs::read(directory.join(MANIFEST_FILE_NAME))?)?;
    manifest.validate(directory)?;
    require_app_version(&manifest, app_version)?;
    let icon = icon_data_url(directory, &manifest.icon)?;
    let entry = directory.join(&manifest.entry).canonicalize()?;
    let definition = loader.load(executable, directory, &entry).await?;
    validate_definition(&manifest.id, &definition)?;
    Ok(ProviderEntry {
        directory: directory.to_path_buf(),
        entry,
        manifest,
        definition,
        icon,
        source_hash: source_hash(directory)?,
    })
}

/// SHA-256 over every file's relative path and content, in sorted path order.
fn source_hash(directory: &Path) -> Result<String> {
    fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                collect(root, &path, files)?;
            } else {
                files.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    collect(directory, directory, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update([0]);
        hasher.update(fs::read(directory.join(&file))?);
        hasher.update([0]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Display text must be a non-empty string or a locale map of non-empty strings.
fn validate_localized_text(value: &serde_json::Value, label: &str) -> Result<()> {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => Ok(()),
        serde_json::Value::Object(map)
            if !map.is_empty()
                && map
                    .values()
                    .all(|entry| entry.as_str().is_some_and(|text| !text.trim().is_empty())) =>
        {
            Ok(())
        }
        _ => Err(Error::Config(format!(
            "{label} must be a non-empty string or a locale map of non-empty strings"
        ))),
    }
}

fn validate_definition(provider_id: &str, definition: &ProviderModuleDefinition) -> Result<()> {
    if definition.channels.is_empty() {
        return Err(Error::Config(format!(
            "provider '{provider_id}' must define at least one channel"
        )));
    }
    let mut channel_ids = std::collections::HashSet::new();
    for channel in &definition.channels {
        validate_id(&channel.id, "channel id")?;
        validate_localized_text(
            &channel.display_name,
            &format!(
                "provider '{provider_id}' channel '{}' displayName",
                channel.id
            ),
        )?;
        if channel.brand.trim().is_empty() {
            return Err(Error::Config(format!(
                "provider '{provider_id}' channel '{}' requires brand",
                channel.id
            )));
        }
        if !channel_ids.insert(channel.id.clone()) {
            return Err(Error::Config(format!(
                "provider '{provider_id}' contains duplicate channel '{}'",
                channel.id
            )));
        }
        if let Some(resource_type) = &channel.resource_type {
            if !definition
                .resources
                .iter()
                .any(|resource| &resource.resource_type == resource_type)
            {
                return Err(Error::Config(format!(
                    "provider '{provider_id}' channel '{}' consumes undeclared resource '{resource_type}'",
                    channel.id
                )));
            }
        }
    }
    let mut resource_types = std::collections::HashSet::new();
    for resource in &definition.resources {
        validate_id(&resource.resource_type, "provider resource type")?;
        validate_localized_text(
            &resource.display_name,
            &format!(
                "provider '{provider_id}' resource '{}' displayName",
                resource.resource_type
            ),
        )?;
        if !resource_types.insert(resource.resource_type.clone()) {
            return Err(Error::Config(format!(
                "provider '{provider_id}' contains duplicate resource type '{}'",
                resource.resource_type
            )));
        }
        for method in &resource.add {
            validate_id(&method.id, "provider add method id")?;
            if !matches!(
                method.method_type.as_str(),
                super::descriptor::OAUTH2_ADD_METHOD
                    | super::descriptor::OAUTH2_AUTHORIZATION_CODE_ADD_METHOD
            ) {
                return Err(Error::Config(format!(
                    "provider '{provider_id}' add method '{}' uses unsupported type '{}'",
                    method.id, method.method_type
                )));
            }
            if method.method_type == super::descriptor::OAUTH2_ADD_METHOD
                && method.callback.is_some()
            {
                return Err(Error::Config(format!(
                    "provider '{provider_id}' device OAuth method '{}' cannot declare callback settings",
                    method.id
                )));
            }
            if let Some(callback) = &method.callback {
                if callback.port == Some(0) {
                    return Err(Error::Config(format!(
                        "provider '{provider_id}' OAuth callback port must be greater than zero"
                    )));
                }
                if let Some(path) = callback.path.as_deref() {
                    if !path.starts_with('/')
                        || path.len() > 128
                        || path.contains('?')
                        || path.contains('#')
                        || path.contains("//")
                    {
                        return Err(Error::Config(format!(
                            "provider '{provider_id}' contains invalid OAuth callback path '{path}'"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

fn icon_data_url(directory: &Path, relative: &str) -> Result<String> {
    let root = directory.canonicalize()?;
    let path = directory.join(relative).canonicalize()?;
    if !path.starts_with(&root) {
        return Err(Error::Config(format!(
            "provider icon escapes its directory: {relative}"
        )));
    }
    if fs::metadata(&path)?.len() > MAX_ICON_BYTES {
        return Err(Error::Config(format!(
            "provider icon exceeds {MAX_ICON_BYTES} bytes: {relative}"
        )));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => {
            return Err(Error::Config(format!(
                "unsupported provider icon: {relative}"
            )))
        }
    };
    Ok(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(fs::read(path)?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_examples_have_valid_static_manifests() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("providers/built-in");
        let sdk = tempfile::tempdir().unwrap();
        let catalog = ProviderCatalog {
            roots: vec![root],
            definition_loader: ProviderDefinitionLoader::for_test(sdk.path()).unwrap(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        };
        assert!(!catalog.manifests().is_empty());
    }
}
