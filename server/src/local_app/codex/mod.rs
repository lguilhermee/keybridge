//! Connects the Codex desktop app and CLI to Keybridge models.
//!
//! Codex reads its model provider from `config.toml` in its home directory. While the
//! connection is on and the server is running, that file selects Keybridge's external
//! API and a model catalog listing every configured model. The user's own selection is
//! remembered in the store and put back whenever Keybridge cannot serve Codex.
mod catalog;
mod config;

use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    api::byok::{public_models, PublicModel},
    provider::ProviderRegistry,
    store::{CodexTakeover, Store},
    Error, Result,
};

use super::IntegrationState;

#[derive(Clone, Debug, Serialize)]
pub struct CodexHarnessStatus {
    pub integration: IntegrationState,
    /// Whether a Codex home directory exists on this machine.
    pub installed: bool,
    pub config_path: String,
    pub configured_models: usize,
    /// The Keybridge model Codex has selected while connected.
    pub model: Option<String>,
}

#[derive(Clone)]
pub struct CodexHarness {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    providers: ProviderRegistry,
    config_path: PathBuf,
    catalog_path: PathBuf,
    backend_addr: RwLock<Option<SocketAddr>>,
    /// Serializes edits of the Codex config and of the takeover record.
    edits: Mutex<()>,
}

/// What Codex must be pointed at for Keybridge to serve it right now.
struct Target {
    base_url: String,
    api_key: String,
    models: Vec<PublicModel>,
}

impl CodexHarness {
    /// Uses the real Codex home and the managed Keybridge data directory.
    pub fn managed(store: Store, providers: ProviderRegistry) -> Result<Self> {
        Ok(Self::new(
            store,
            providers,
            config::home()?,
            crate::config::managed_data_dir()?
                .join("codex")
                .join("models.json"),
        ))
    }

    pub fn new(
        store: Store,
        providers: ProviderRegistry,
        codex_home: PathBuf,
        catalog_path: PathBuf,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                providers,
                config_path: codex_home.join("config.toml"),
                catalog_path,
                backend_addr: RwLock::new(None),
                edits: Mutex::new(()),
            }),
        }
    }

    pub fn set_backend_addr(&self, addr: SocketAddr) {
        *self.inner.backend_addr.write() = Some(addr);
    }

    pub async fn status(&self) -> Result<CodexHarnessStatus> {
        let _edits = self.inner.edits.lock().await;
        if let Err(error) = self.apply().await {
            tracing::warn!(%error, "could not bring the Codex config up to date");
        }
        let takeover = self.inner.store.codex_takeover().await?;
        let configured_models = public_models(&self.inner.store, &self.inner.providers)
            .await?
            .len();
        let mut model = None;
        let integration = if !takeover.enabled {
            IntegrationState::Disabled
        } else {
            let document = config::load(&self.inner.config_path)?;
            let connected = self.target().await?.is_some_and(|target| {
                let slugs = target.slugs();
                config::matches(&document, &self.connection(&target, &slugs))
            });
            if connected {
                model = config::selected_model(&document);
                IntegrationState::Enabled
            } else {
                IntegrationState::Degraded
            }
        };
        Ok(CodexHarnessStatus {
            integration,
            installed: self
                .inner
                .config_path
                .parent()
                .is_some_and(|home| home.is_dir()),
            config_path: self.inner.config_path.to_string_lossy().into_owned(),
            configured_models,
            model,
        })
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<CodexHarnessStatus> {
        {
            let _edits = self.inner.edits.lock().await;
            if enabled {
                if public_models(&self.inner.store, &self.inner.providers)
                    .await?
                    .is_empty()
                {
                    return Err(Error::Config("add a model before connecting Codex".into()));
                }
                self.enable_external_api().await?;
            }
            let mut takeover = self.inner.store.codex_takeover().await?;
            takeover.enabled = enabled;
            self.inner.store.set_codex_takeover(&takeover).await?;
            self.apply().await?;
        }
        self.status().await
    }

    /// Brings the Codex config in line after models, ports, or the external API changed.
    pub async fn refresh(&self) {
        let _edits = self.inner.edits.lock().await;
        if let Err(error) = self.apply().await {
            tracing::warn!(%error, "could not bring the Codex config up to date");
        }
    }

    /// Takes Keybridge out of the Codex config for as long as the server is stopped.
    /// The connection stays on, so the next start puts it back.
    pub async fn release(&self) -> Result<()> {
        let _edits = self.inner.edits.lock().await;
        *self.inner.backend_addr.write() = None;
        self.apply().await
    }

    /// Codex authenticates with the external API key, so connecting turns that API on.
    async fn enable_external_api(&self) -> Result<()> {
        let mut settings = self.inner.store.external_api_settings().await?;
        if settings.enabled && !settings.api_key.is_empty() {
            return Ok(());
        }
        if settings.api_key.is_empty() {
            settings.api_key = format!("kb-{}", uuid::Uuid::new_v4().simple());
        }
        settings.enabled = true;
        self.inner.store.set_external_api_settings(settings).await?;
        Ok(())
    }

    /// `None` whenever Keybridge cannot serve Codex: the server is not listening, the
    /// external API is off, or no model is configured (Codex rejects an empty catalog).
    async fn target(&self) -> Result<Option<Target>> {
        let Some(addr) = *self.inner.backend_addr.read() else {
            return Ok(None);
        };
        let api = self.inner.store.external_api_settings().await?;
        if !api.enabled || api.api_key.is_empty() {
            return Ok(None);
        }
        let models = public_models(&self.inner.store, &self.inner.providers).await?;
        if models.is_empty() {
            return Ok(None);
        }
        Ok(Some(Target {
            base_url: format!("http://127.0.0.1:{}/byok/v1", addr.port()),
            api_key: api.api_key,
            models,
        }))
    }

    fn connection<'a>(&'a self, target: &'a Target, slugs: &'a [String]) -> config::Connection<'a> {
        config::Connection {
            base_url: &target.base_url,
            api_key: &target.api_key,
            catalog_path: self.inner.catalog_path.to_str().unwrap_or_default(),
            models: slugs,
        }
    }

    /// Writes Keybridge into the Codex config when it should be there and removes it
    /// when it should not. Callers hold `edits`.
    async fn apply(&self) -> Result<()> {
        let mut takeover = self.inner.store.codex_takeover().await?;
        let target = if takeover.enabled {
            self.target().await?
        } else {
            None
        };
        match target {
            Some(target) => self.connect(&mut takeover, &target).await,
            // `previous` is recorded exactly while Keybridge is written into the config.
            None if takeover.previous.is_some() => self.disconnect(&mut takeover).await,
            None => Ok(()),
        }
    }

    async fn connect(&self, takeover: &mut CodexTakeover, target: &Target) -> Result<()> {
        let slugs = target.slugs();
        let connection = self.connection(target, &slugs);
        if connection.catalog_path.is_empty() {
            return Err(Error::Config(
                "Keybridge data directory is not a valid UTF-8 path".into(),
            ));
        }
        write_if_changed(
            &self.inner.catalog_path,
            &serde_json::to_string(&catalog::render(&target.models))?,
        )?;
        let mut document = config::load(&self.inner.config_path)?;
        if takeover.previous.is_none() || !config::selects_keybridge(&document) {
            // Remember the user's own selection before replacing it.
            let mut previous = config::selection(&document);
            if previous.model_catalog_json.as_deref() == Some(connection.catalog_path) {
                previous.model_catalog_json = None;
            }
            if config::selects_keybridge(&document) {
                previous.model = None;
                previous.model_provider = None;
            }
            takeover.previous = Some(previous);
            self.inner.store.set_codex_takeover(takeover).await?;
        }
        config::connect(&mut document, &connection)?;
        config::save(&self.inner.config_path, &document)
    }

    async fn disconnect(&self, takeover: &mut CodexTakeover) -> Result<()> {
        if self.inner.config_path.exists() {
            let mut document = config::load(&self.inner.config_path)?;
            config::disconnect(
                &mut document,
                &takeover.previous.clone().unwrap_or_default(),
                self.inner.catalog_path.to_str().unwrap_or_default(),
            );
            config::save(&self.inner.config_path, &document)?;
        }
        takeover.previous = None;
        self.inner.store.set_codex_takeover(takeover).await
    }
}

impl Target {
    fn slugs(&self) -> Vec<String> {
        self.models
            .iter()
            .map(|model| model.public_id.clone())
            .collect()
    }
}

fn write_if_changed(path: &Path, text: &str) -> Result<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text)?;
    fs::rename(temp, path)?;
    Ok(())
}
