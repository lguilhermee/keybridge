//! Connects the Claude Code CLI to Keybridge's Anthropic Messages API.
mod config;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    api::byok::public_models,
    provider::ProviderRegistry,
    store::{ClaudeCodeTakeover, Store},
    Error, Result,
};

use super::IntegrationState;

#[derive(Clone, Debug, Serialize)]
pub struct ClaudeCodeHarnessStatus {
    pub integration: IntegrationState,
    pub installed: bool,
    pub config_path: String,
    pub configured_models: usize,
    pub model: Option<String>,
}

#[derive(Clone)]
pub struct ClaudeCodeHarness {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    providers: ProviderRegistry,
    config_path: PathBuf,
    backend_addr: RwLock<Option<SocketAddr>>,
    edits: Mutex<()>,
}

impl ClaudeCodeHarness {
    pub fn managed(store: Store, providers: ProviderRegistry) -> Result<Self> {
        Ok(Self::new(store, providers, config::path()?))
    }

    pub fn new(store: Store, providers: ProviderRegistry, config_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                providers,
                config_path,
                backend_addr: RwLock::new(None),
                edits: Mutex::new(()),
            }),
        }
    }

    pub fn set_backend_addr(&self, addr: SocketAddr) {
        *self.inner.backend_addr.write() = Some(addr);
    }

    pub async fn status(&self) -> Result<ClaudeCodeHarnessStatus> {
        let _edits = self.inner.edits.lock().await;
        if let Err(error) = self.apply().await {
            tracing::warn!(%error, "could not bring the Claude Code settings up to date");
        }
        let takeover = self.inner.store.claude_code_takeover().await?;
        let models = public_models(&self.inner.store, &self.inner.providers).await?;
        let mut model = None;
        let integration = if !takeover.enabled {
            IntegrationState::Disabled
        } else if let Some((base_url, api_key)) = self.target().await? {
            let settings = config::load(&self.inner.config_path)?;
            let slugs = models
                .iter()
                .map(|model| model.public_id.clone())
                .collect::<Vec<_>>();
            if config::matches(&settings, &base_url, &api_key, &slugs) {
                model = config::selected_model(&settings);
                IntegrationState::Enabled
            } else {
                IntegrationState::Degraded
            }
        } else {
            IntegrationState::Degraded
        };
        Ok(ClaudeCodeHarnessStatus {
            integration,
            installed: self
                .inner
                .config_path
                .parent()
                .is_some_and(|home| home.is_dir()),
            config_path: self.inner.config_path.to_string_lossy().into_owned(),
            configured_models: models.len(),
            model,
        })
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<ClaudeCodeHarnessStatus> {
        {
            let _edits = self.inner.edits.lock().await;
            if enabled {
                if public_models(&self.inner.store, &self.inner.providers)
                    .await?
                    .is_empty()
                {
                    return Err(Error::Config(
                        "add a model before connecting Claude Code".into(),
                    ));
                }
                let mut api = self.inner.store.external_api_settings().await?;
                if api.api_key.is_empty() {
                    api.api_key = format!("kb-{}", uuid::Uuid::new_v4().simple());
                }
                api.enabled = true;
                self.inner.store.set_external_api_settings(api).await?;
            }
            let mut takeover = self.inner.store.claude_code_takeover().await?;
            takeover.enabled = enabled;
            self.inner.store.set_claude_code_takeover(&takeover).await?;
            self.apply().await?;
        }
        self.status().await
    }

    pub async fn refresh(&self) {
        let _edits = self.inner.edits.lock().await;
        if let Err(error) = self.apply().await {
            tracing::warn!(%error, "could not bring the Claude Code settings up to date");
        }
    }

    pub async fn release(&self) -> Result<()> {
        let _edits = self.inner.edits.lock().await;
        *self.inner.backend_addr.write() = None;
        self.apply().await
    }

    async fn target(&self) -> Result<Option<(String, String)>> {
        let Some(addr) = *self.inner.backend_addr.read() else {
            return Ok(None);
        };
        let api = self.inner.store.external_api_settings().await?;
        if !api.enabled
            || api.api_key.is_empty()
            || public_models(&self.inner.store, &self.inner.providers)
                .await?
                .is_empty()
        {
            return Ok(None);
        }
        Ok(Some((
            format!("http://127.0.0.1:{}/byok", addr.port()),
            api.api_key,
        )))
    }

    async fn apply(&self) -> Result<()> {
        let mut takeover = self.inner.store.claude_code_takeover().await?;
        let target = if takeover.enabled {
            self.target().await?
        } else {
            None
        };
        match target {
            Some((base_url, api_key)) => self.connect(&mut takeover, &base_url, &api_key).await,
            None if takeover.previous.is_some() => self.disconnect(&mut takeover).await,
            None => Ok(()),
        }
    }

    async fn connect(
        &self,
        takeover: &mut ClaudeCodeTakeover,
        base_url: &str,
        api_key: &str,
    ) -> Result<()> {
        let models = public_models(&self.inner.store, &self.inner.providers)
            .await?
            .into_iter()
            .map(|model| model.public_id)
            .collect::<Vec<_>>();
        let mut settings = config::load(&self.inner.config_path)?;
        if takeover.previous.is_none() || !config::selects_keybridge(&settings) {
            takeover.previous = Some(config::selection(&settings));
            self.inner.store.set_claude_code_takeover(takeover).await?;
        }
        config::connect(&mut settings, base_url, api_key, &models)?;
        config::save(&self.inner.config_path, &settings)
    }

    async fn disconnect(&self, takeover: &mut ClaudeCodeTakeover) -> Result<()> {
        if self.inner.config_path.exists() {
            let mut settings = config::load(&self.inner.config_path)?;
            if config::selects_keybridge(&settings) {
                config::disconnect(
                    &mut settings,
                    takeover
                        .previous
                        .as_ref()
                        .expect("takeover has a previous selection"),
                )?;
                config::save(&self.inner.config_path, &settings)?;
            }
        }
        takeover.previous = None;
        self.inner.store.set_claude_code_takeover(takeover).await
    }
}
