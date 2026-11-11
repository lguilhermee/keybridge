//! Orchestrates provider capabilities: resources, model catalogs, and invocation.
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
    time::Duration,
};

use async_stream::try_stream;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::{ProviderCatalog, ProviderEntry},
    data::ProviderDataStore,
    descriptor::{
        parse_model_id, ChannelDefinition, ChannelDescriptor, ProviderDescriptor,
        ProviderModelDescriptor, ProviderResourceDescriptor, ProviderResourceView,
        ResourceActionResponse, ResourceActionResult, ResourceDefinition, ResourcePresentation,
        OAUTH2_ADD_METHOD, OAUTH2_AUTHORIZATION_CODE_ADD_METHOD,
    },
    oauth_callback::{self, CallbackHandle, CallbackOutcome, CallbackRequest},
    runtime::ProviderRuntime,
    state::{
        now_ms, ProviderStateStore, ResourceDraft, ResourcePatch, ResourceRecord, StoredModel,
    },
    wire,
    worker::{ProviderWorker, WorkerStreamItem},
};
use crate::{
    model::ModelInvocation,
    protocol::ProtocolStream,
    protocol::{CallRecorder, ModelEvent},
    store::Store,
    Error, Result,
};

const OAUTH_SLOW_DOWN_STEP_MS: i64 = 5_000;
const MAX_IMPORT_DRAFTS: usize = 256;

#[derive(Clone)]
pub struct ProviderRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    store: Store,
    runtime: ProviderRuntime,
    catalog: ProviderCatalog,
    state: ProviderStateStore,
    headroom: crate::headroom::HeadroomRuntime,
    entries: RwLock<Option<Vec<ProviderEntry>>>,
    workers: Mutex<HashMap<String, Arc<ProviderWorker>>>,
    oauth_sessions: Mutex<HashMap<String, OAuthSession>>,
    /// `provider/channel/source hash` catalogs already re-synced (or tried) after a code change.
    catalog_refreshes: Mutex<HashSet<String>>,
}

struct OAuthSession {
    provider_id: String,
    resource_type: String,
    method_id: String,
    session: serde_json::Value,
    expires_at_ms: i64,
    poll_interval_ms: i64,
    next_poll_at_ms: i64,
    flow: OAuthFlow,
}

enum OAuthFlow {
    DeviceCode,
    AuthorizationCode {
        redirect_uri: String,
        code_verifier: String,
        callback: CallbackHandle,
    },
}

enum OAuthPollWork {
    DeviceCode {
        provider_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    },
    AuthorizationCode {
        provider_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginResponse {
    pub session_id: String,
    pub user_code: Option<String>,
    pub verification_url: String,
    pub verification_url_complete: Option<String>,
    pub expires_at_ms: i64,
    pub poll_interval_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OAuthPollResponse {
    #[serde(rename_all = "camelCase")]
    Pending { poll_interval_ms: i64 },
    #[serde(rename_all = "camelCase")]
    Completed {
        added: usize,
        updated: usize,
        model_sync_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Denied { message: Option<String> },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub added: usize,
    pub updated: usize,
    pub warnings: Vec<String>,
    pub model_sync_error: Option<String>,
}

/// Provider model metadata the routing branch needs when creating a Recorder.
#[derive(Clone, Debug)]
pub struct ProviderInvocationPlan {
    pub model: ProviderModelDescriptor,
    pub request_url: String,
}

impl ProviderRegistry {
    pub fn managed(
        store: Store,
        runtime: ProviderRuntime,
        app_version: String,
        headroom: crate::headroom::HeadroomRuntime,
    ) -> Result<Self> {
        let data = ProviderDataStore::managed()?;
        Ok(Self {
            inner: Arc::new(RegistryInner {
                store,
                runtime,
                catalog: ProviderCatalog::managed(app_version)?,
                state: ProviderStateStore::new(data),
                headroom,
                entries: RwLock::new(None),
                workers: Mutex::new(HashMap::new()),
                oauth_sessions: Mutex::new(HashMap::new()),
                catalog_refreshes: Mutex::new(HashSet::new()),
            }),
        })
    }

    pub async fn providers(&self) -> Vec<ProviderDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return self
                .inner
                .catalog
                .manifests()
                .into_iter()
                .map(|(manifest, icon)| ProviderDescriptor {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    author: manifest.author,
                    icon,
                    channels: Vec::new(),
                    resources: Vec::new(),
                })
                .collect();
        };
        let mut providers = Vec::new();
        let entries = self.entries(&executable).await;
        self.refresh_stale_catalogs(&entries, &executable).await;
        for entry in entries {
            providers.push(self.descriptor(&entry, &executable).await);
        }
        providers
    }

    /// All provider models whose invocation prerequisites are satisfied; each enters the Cursor catalog independently.
    pub async fn configured_models(&self) -> Vec<ProviderModelDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return Vec::new();
        };
        let mut models = Vec::new();
        let entries = self.entries(&executable).await;
        self.refresh_stale_catalogs(&entries, &executable).await;
        for entry in entries {
            for channel in &entry.definition.channels {
                if !self.channel_configured(&entry, channel).await {
                    continue;
                }
                let stored = self
                    .inner
                    .state
                    .models(&entry.manifest.id, &channel.id)
                    .await
                    .unwrap_or_default();
                models.extend(stored.iter().filter(|model| model.enabled).map(|model| {
                    ProviderModelDescriptor::new(
                        &entry.manifest.id,
                        &entry.manifest.name,
                        &entry.icon,
                        channel,
                        model,
                    )
                }));
            }
        }
        models
    }

    pub async fn model_descriptor(&self, model_id: &str) -> Result<ProviderModelDescriptor> {
        let (provider_id, channel_id, upstream_id) = parse_model_id(model_id)
            .ok_or_else(|| Error::Provider(format!("invalid provider model ID: {model_id}")))?;
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let channel = find_channel(&entry, channel_id)?;
        let stored = self
            .inner
            .state
            .models(provider_id, channel_id)
            .await?
            .into_iter()
            .find(|model| model.id == upstream_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider model {model_id}")))?;
        Ok(ProviderModelDescriptor::new(
            provider_id,
            &entry.manifest.name,
            &entry.icon,
            channel,
            &stored,
        ))
    }

    pub async fn plan_model(&self, model_id: &str) -> Result<ProviderInvocationPlan> {
        let model = self.model_descriptor(model_id).await?;
        let request_url = format!("provider://{}/{}", model.provider_id, model.channel_id);
        Ok(ProviderInvocationPlan { model, request_url })
    }

    /// The unified Protocol stream for provider models: picks the first usable resource and executes via the Worker,
    /// with events flowing through the same pipeline as built-in Protocols. Future load balancing retries here.
    pub fn stream_model(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
        recorder: CallRecorder,
    ) -> ProtocolStream {
        let registry = self.clone();
        Box::pin(try_stream! {
            let model_id = invocation.request.model.model_id.clone();
            let (provider_id, channel_id, upstream_id) = parse_model_id(&model_id)
                .map(|(provider, channel, model)| (provider.to_owned(), channel.to_owned(), model.to_owned()))
                .ok_or_else(|| Error::Provider(format!("invalid provider model ID: {model_id}")))?;
            let executable = registry.executable()?;
            let entry = registry.find_entry(&executable, &provider_id).await?;
            let channel = find_channel(&entry, &channel_id)?.clone();
            let stored = registry.inner.state.models(&provider_id, &channel_id).await?
                .into_iter()
                .find(|model| model.id == upstream_id)
                .ok_or_else(|| Error::RunNotFound(format!("provider model {model_id}")))?;
            let candidates: Vec<Option<(String, ResourceRecord)>> = match &channel.resource_type {
                Some(resource_type) => registry
                    .select_resources(&provider_id, resource_type)
                    .await?
                    .into_iter()
                    .map(|record| Some((resource_type.clone(), record)))
                    .collect(),
                None => vec![None],
            };
            let total_candidates = candidates.len();
            let request = wire::llm_request(&invocation)?;
            let worker = registry.worker(&entry, &executable).await;
            yield ModelEvent::Start { model_call_id: invocation.call_id.clone() };
            for (attempt_index, resource) in candidates.into_iter().enumerate() {
                let params = serde_json::json!({
                    "channelId": channel_id,
                    "model": stored.snapshot(),
                    "resource": resource.as_ref().map(|(resource_type, record)| record.snapshot(resource_type)),
                    "request": request,
                });
                let mut items = worker
                    .invoke_streaming(
                        "provider.invoke",
                        params,
                        cancellation.clone(),
                        Some(recorder.clone()),
                    )
                    .await?;
                let mut emitted = false;
                let mut switch_to_next = false;
                while let Some(item) = items.recv().await {
                    match item {
                        WorkerStreamItem::Event(event) => {
                            emitted = true;
                            yield wire::model_event(&event)?;
                        }
                        WorkerStreamItem::Result(result) => {
                            let value = result?;
                            let status = value
                                .get("status")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default();
                            let patch = value
                                .get("patch")
                                .filter(|patch| !patch.is_null())
                                .map(|patch| serde_json::from_value::<ResourcePatch>(patch.clone()))
                                .transpose()?;
                            if let (Some(patch), Some((resource_type, record))) =
                                (patch, resource.as_ref())
                            {
                                if let Err(error) = registry
                                    .inner
                                    .state
                                    .apply_patch(&provider_id, resource_type, &record.id, patch)
                                    .await
                                {
                                    tracing::warn!(provider = %provider_id, %error, "failed to apply provider resource patch");
                                }
                            }
                            match status {
                                "completed" => return,
                                "resource-error" => {
                                    let message = value
                                        .get("message")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("provider channel call failed");
                                    if !emitted && attempt_index + 1 < total_candidates {
                                        tracing::warn!(
                                            provider = %provider_id,
                                            attempt = attempt_index + 1,
                                            total = total_candidates,
                                            %message,
                                            "provider resource hit limit or failed before output; switching to next resource"
                                        );
                                        switch_to_next = true;
                                        break;
                                    }
                                    Err(Error::Provider(message.to_owned()))?;
                                }
                                "request-error" => {
                                    let message = value
                                        .get("message")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("provider channel call failed");
                                    Err(Error::Provider(message.to_owned()))?;
                                }
                                status => {
                                    Err(Error::Protocol(format!(
                                        "unknown provider channel result: {status}"
                                    )))?;
                                }
                            }
                        }
                    }
                }
                if switch_to_next {
                    continue;
                }
                Err(Error::Provider(format!(
                    "provider '{provider_id}' worker stopped mid-stream"
                )))?;
            }
        })
    }

    pub async fn oauth_begin(
        &self,
        provider_id: &str,
        resource_type: &str,
        method_id: &str,
    ) -> Result<OAuthBeginResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let method = resource
            .add
            .iter()
            .find(|method| method.id == method_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "provider '{provider_id}' does not define OAuth method '{method_id}'"
                ))
            })?;
        // Each add entry point has a single active lifecycle. Restarting drops the old session first,
        // and dropping the CallbackHandle in the authorization-code session releases the loopback listener at once.
        self.inner.oauth_sessions.lock().await.retain(|_, session| {
            session.provider_id != provider_id
                || session.resource_type != resource_type
                || session.method_id != method_id
        });
        let worker = self.worker(&entry, &executable).await;
        let session_id = uuid::Uuid::new_v4().to_string();

        let (
            session,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
            flow,
            user_code,
        ) = match method.method_type.as_str() {
            OAUTH2_ADD_METHOD => {
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2Begin = serde_json::from_value(value)?;
                (
                    begin.session,
                    begin.verification_url,
                    begin.verification_url_complete,
                    begin.expires_at_ms,
                    begin.poll_interval_ms.max(1_000),
                    OAuthFlow::DeviceCode,
                    Some(begin.user_code),
                )
            }
            OAUTH2_AUTHORIZATION_CODE_ADD_METHOD => {
                let state = oauth_random_secret();
                let code_verifier = oauth_random_secret();
                let code_challenge =
                    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
                let callback = method.callback.as_ref();
                let callback = oauth_callback::bind(
                    callback.and_then(|value| value.port),
                    callback
                        .and_then(|value| value.path.as_deref())
                        .unwrap_or("/oauth-callback"),
                    state.clone(),
                    entry.manifest.name.clone(),
                    entry.icon.clone(),
                    serde_json::to_value(&resource.display_name)?,
                )
                .await?;
                let redirect_uri = callback.redirect_uri.clone();
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                            "authorization": {
                                "redirectUri": redirect_uri,
                                "state": state,
                                "codeChallenge": code_challenge,
                            },
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2AuthorizationCodeBegin = serde_json::from_value(value)?;
                let poll_interval_ms = begin.poll_interval_ms.unwrap_or(1_000).max(1_000);
                (
                    begin.session,
                    begin.authorization_url,
                    None,
                    begin.expires_at_ms,
                    poll_interval_ms,
                    OAuthFlow::AuthorizationCode {
                        redirect_uri,
                        code_verifier,
                        callback,
                    },
                    None,
                )
            }
            method_type => {
                return Err(Error::Config(format!(
                        "provider '{provider_id}' OAuth method '{method_id}' uses unsupported type '{method_type}'"
                    )));
            }
        };

        if expires_at_ms <= now_ms() {
            return Err(Error::Protocol(format!(
                "provider '{provider_id}' OAuth method '{method_id}' returned an expired session"
            )));
        }
        self.inner.oauth_sessions.lock().await.insert(
            session_id.clone(),
            OAuthSession {
                provider_id: provider_id.to_owned(),
                resource_type: resource_type.to_owned(),
                method_id: method_id.to_owned(),
                session,
                expires_at_ms,
                poll_interval_ms,
                next_poll_at_ms: now_ms() + poll_interval_ms,
                flow,
            },
        );
        let cleanup = self.clone();
        let cleanup_session_id = session_id.clone();
        let cleanup_delay_ms = expires_at_ms.saturating_sub(now_ms()) as u64;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(cleanup_delay_ms)).await;
            cleanup
                .inner
                .oauth_sessions
                .lock()
                .await
                .remove(&cleanup_session_id);
        });
        Ok(OAuthBeginResponse {
            session_id,
            user_code,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
        })
    }

    pub async fn oauth_poll(&self, session_id: &str) -> Result<OAuthPollResponse> {
        let work = {
            let now = now_ms();
            let mut sessions = self.inner.oauth_sessions.lock().await;
            let Some(state) = sessions.get_mut(session_id) else {
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization session no longer exists".into(),
                });
            };
            if now >= state.expires_at_ms {
                sessions.remove(session_id);
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization expired".into(),
                });
            }
            if now < state.next_poll_at_ms {
                return Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: state.poll_interval_ms,
                });
            }
            state.next_poll_at_ms = now + state.poll_interval_ms;

            let common = (
                state.provider_id.clone(),
                state.resource_type.clone(),
                state.method_id.clone(),
                state.session.clone(),
            );
            match &mut state.flow {
                OAuthFlow::DeviceCode => OAuthPollWork::DeviceCode {
                    provider_id: common.0,
                    resource_type: common.1,
                    method_id: common.2,
                    session: common.3,
                    poll_interval_ms: state.poll_interval_ms,
                },
                OAuthFlow::AuthorizationCode {
                    redirect_uri,
                    code_verifier,
                    callback,
                } => match callback.receiver.try_recv() {
                    Ok(callback_request) => OAuthPollWork::AuthorizationCode {
                        provider_id: common.0,
                        resource_type: common.1,
                        method_id: common.2,
                        session: common.3,
                        redirect_uri: redirect_uri.clone(),
                        code_verifier: code_verifier.clone(),
                        callback_request,
                    },
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        return Ok(OAuthPollResponse::Pending {
                            poll_interval_ms: state.poll_interval_ms,
                        });
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        sessions.remove(session_id);
                        return Ok(OAuthPollResponse::Failed {
                            message: "authorization callback stopped before completion".into(),
                        });
                    }
                },
            }
        };

        match work {
            OAuthPollWork::DeviceCode {
                provider_id,
                resource_type,
                method_id,
                session,
                poll_interval_ms,
            } => {
                self.poll_device_code(
                    session_id,
                    provider_id,
                    resource_type,
                    method_id,
                    session,
                    poll_interval_ms,
                )
                .await
            }
            OAuthPollWork::AuthorizationCode {
                provider_id,
                resource_type,
                method_id,
                session,
                redirect_uri,
                code_verifier,
                callback_request,
            } => {
                self.complete_authorization_code(
                    session_id,
                    provider_id,
                    resource_type,
                    method_id,
                    session,
                    redirect_uri,
                    code_verifier,
                    callback_request,
                )
                .await
            }
        }
    }

    async fn poll_device_code(
        &self,
        session_id: &str,
        provider_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    ) -> Result<OAuthPollResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, &provider_id).await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "oauth.poll",
                serde_json::json!({
                    "resourceType": resource_type,
                    "methodId": method_id,
                    "session": session,
                }),
                CancellationToken::new(),
            )
            .await?;
        let poll: OAuth2Poll = serde_json::from_value(value)?;
        match poll {
            OAuth2Poll::Pending { session } => {
                self.update_session(session_id, session, None).await;
                Ok(OAuthPollResponse::Pending { poll_interval_ms })
            }
            OAuth2Poll::SlowDown { session } => {
                let interval = poll_interval_ms + OAUTH_SLOW_DOWN_STEP_MS;
                self.update_session(session_id, session, Some(interval))
                    .await;
                Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: interval,
                })
            }
            OAuth2Poll::Completed { resources } => {
                // The device-code session is destroyed only after persistence succeeds: a transient write failure can retry on the next poll.
                let response = self
                    .persist_oauth_resources(
                        &entry,
                        &executable,
                        &provider_id,
                        &resource_type,
                        resources,
                    )
                    .await?;
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(response)
            }
            OAuth2Poll::Denied { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Denied { message })
            }
            OAuth2Poll::Failed { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn complete_authorization_code(
        &self,
        session_id: &str,
        provider_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    ) -> Result<OAuthPollResponse> {
        let CallbackRequest { result, response } = callback_request;
        let code = match result {
            Ok(code) => code,
            Err(message) => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                return Ok(OAuthPollResponse::Denied {
                    message: Some(message),
                });
            }
        };

        let result = async {
            let executable = self.executable()?;
            let entry = self.find_entry(&executable, &provider_id).await?;
            let value = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "oauth.complete",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "methodId": method_id,
                        "session": session,
                        "authorization": {
                            "code": code,
                            "redirectUri": redirect_uri,
                            "codeVerifier": code_verifier,
                        },
                    }),
                    CancellationToken::new(),
                )
                .await?;
            let resources: Vec<ResourceDraft> = serde_json::from_value(value)?;
            self.persist_oauth_resources(
                &entry,
                &executable,
                &provider_id,
                &resource_type,
                resources,
            )
            .await
        }
        .await;

        self.inner.oauth_sessions.lock().await.remove(session_id);
        match result {
            Ok(completed) => {
                let _ = response.send(CallbackOutcome {
                    success: true,
                    message: None,
                });
                Ok(completed)
            }
            Err(error) => {
                let message = error.to_string();
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    async fn persist_oauth_resources(
        &self,
        entry: &ProviderEntry,
        executable: &Path,
        provider_id: &str,
        resource_type: &str,
        resources: Vec<ResourceDraft>,
    ) -> Result<OAuthPollResponse> {
        let outcome = self
            .inner
            .state
            .upsert_resources(provider_id, resource_type, resources)
            .await?;
        let model_sync_error = self
            .sync_channel_models_for_resource(entry, executable, resource_type)
            .await;
        Ok(OAuthPollResponse::Completed {
            added: outcome.added,
            updated: outcome.updated,
            model_sync_error,
        })
    }

    pub async fn import_resources(
        &self,
        provider_id: &str,
        resource_type: &str,
        files: serde_json::Value,
    ) -> Result<ImportResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if resource.import.is_none() {
            return Err(Error::Config(format!(
                "provider '{provider_id}' resource '{resource_type}' does not support import"
            )));
        }
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "import.parse",
                serde_json::json!({ "resourceType": resource_type, "files": files }),
                CancellationToken::new(),
            )
            .await?;
        let parsed: ImportParseResult = serde_json::from_value(value)?;
        if parsed.resources.is_empty() {
            return Err(Error::Config(
                parsed
                    .warnings
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "import produced no resources".into()),
            ));
        }
        if parsed.resources.len() > MAX_IMPORT_DRAFTS {
            return Err(Error::Config(format!(
                "import produced more than {MAX_IMPORT_DRAFTS} resources"
            )));
        }
        let outcome = self
            .inner
            .state
            .upsert_resources(provider_id, resource_type, parsed.resources)
            .await?;
        let model_sync_error = self
            .sync_channel_models_for_resource(&entry, &executable, resource_type)
            .await;
        Ok(ImportResponse {
            added: outcome.added,
            updated: outcome.updated,
            warnings: parsed.warnings,
            model_sync_error,
        })
    }

    /// Exports all private data for one resource type for backup or migration; format matches bulk import.
    pub async fn export_resources(
        &self,
        provider_id: &str,
        resource_type: &str,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        find_resource(&entry, resource_type)?;
        let records = self
            .inner
            .state
            .resources(provider_id, resource_type)
            .await?;
        Ok(serde_json::json!({
            "accounts": records
                .iter()
                .map(|record| record.private_data.clone())
                .collect::<Vec<_>>(),
        }))
    }

    pub async fn refresh_resource(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if !resource.can_refresh {
            return Err(Error::Config(format!(
                "provider '{provider_id}' resource '{resource_type}' does not support refresh"
            )));
        }
        let record = self
            .find_record(provider_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.refresh",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resource": record.snapshot(resource_type),
                }),
                CancellationToken::new(),
            )
            .await?;
        let patch: ResourcePatch = serde_json::from_value(value)?;
        self.inner
            .state
            .apply_patch(provider_id, resource_type, resource_id, patch)
            .await
    }

    pub async fn resource_action(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
        action_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let action = resource
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "provider '{provider_id}' resource '{resource_type}' does not define action '{action_id}'"
                ))
            })?;
        if !matches!(action.target.as_str(), "resource" | "card") {
            return Err(Error::Config(format!(
                "provider '{provider_id}' resource action '{action_id}' has an invalid target"
            )));
        }
        let record = self
            .find_record(provider_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.action",
                serde_json::json!({
                    "resourceType": resource_type,
                    "actionId": action_id,
                    "resource": record.snapshot(resource_type),
                    "input": input,
                }),
                CancellationToken::new(),
            )
            .await?;
        let result: ResourceActionResult = serde_json::from_value(value)?;
        if let Some(patch) = result.patch.clone() {
            self.inner
                .state
                .apply_patch(provider_id, resource_type, resource_id, patch)
                .await?;
        }
        Ok(serde_json::to_value(ResourceActionResponse::from(result))?)
    }

    pub async fn delete_resource(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let record = self
            .find_record(provider_id, resource_type, resource_id)
            .await?;
        if resource.can_remove {
            // An upstream revoke failure does not block local deletion: users must be able to remove dead resources.
            if let Err(error) = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.remove",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "resource": record.snapshot(resource_type),
                    }),
                    CancellationToken::new(),
                )
                .await
            {
                tracing::warn!(provider = %provider_id, %error, "provider resource remove hook failed");
            }
        }
        self.inner
            .state
            .remove_resource(provider_id, resource_type, resource_id)
            .await?;
        Ok(())
    }

    pub async fn sync_models(&self, provider_id: &str, channel_id: &str) -> Result<usize> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let channel = find_channel(&entry, channel_id)?.clone();
        self.sync_channel_models(&entry, &executable, &channel)
            .await
    }

    pub async fn set_model_enabled(
        &self,
        provider_id: &str,
        channel_id: &str,
        model_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, provider_id).await?;
        let channel = find_channel(&entry, channel_id)?;
        if !channel.has_models {
            return Err(Error::Config(format!(
                "provider channel '{channel_id}' does not enumerate models"
            )));
        }
        self.inner
            .state
            .set_model_enabled(provider_id, channel_id, model_id, enabled)
            .await
    }

    pub async fn remove(&self, provider_id: &str) -> Result<()> {
        if let Some(worker) = self.inner.workers.lock().await.remove(provider_id) {
            worker.stop().await;
        }
        self.inner.state.clear(provider_id).await
    }

    async fn descriptor(&self, entry: &ProviderEntry, executable: &Path) -> ProviderDescriptor {
        let provider_id = &entry.manifest.id;
        let mut channels = Vec::new();
        for channel in &entry.definition.channels {
            let stored = self
                .inner
                .state
                .models(provider_id, &channel.id)
                .await
                .unwrap_or_default();
            let configured = self.channel_configured(entry, channel).await;
            channels.push(ChannelDescriptor {
                id: channel.id.clone(),
                provider_id: provider_id.clone(),
                display_name: channel.display_name.clone(),
                description: channel.description.clone(),
                brand: channel.brand.clone(),
                resource_type: channel.resource_type.clone(),
                has_models: channel.has_models,
                configured,
                models: stored
                    .iter()
                    .map(|model| {
                        ProviderModelDescriptor::new(
                            provider_id,
                            &entry.manifest.name,
                            &entry.icon,
                            channel,
                            model,
                        )
                    })
                    .collect(),
            });
        }
        let mut resources = Vec::new();
        for definition in &entry.definition.resources {
            let records = self
                .inner
                .state
                .resources(provider_id, &definition.resource_type)
                .await
                .unwrap_or_default();
            let views = self
                .present_resources(entry, executable, definition, &records)
                .await;
            resources.push(ProviderResourceDescriptor {
                resource_type: definition.resource_type.clone(),
                display_name: definition.display_name.clone(),
                add: definition.add.clone(),
                import: definition.import.clone(),
                actions: definition.actions.clone(),
                can_refresh: definition.can_refresh,
                can_remove: definition.can_remove,
                resources: views,
            });
        }
        ProviderDescriptor {
            id: provider_id.clone(),
            name: entry.manifest.name.clone(),
            version: entry.manifest.version.clone(),
            author: entry.manifest.author.clone(),
            icon: entry.icon.clone(),
            channels,
            resources,
        }
    }

    async fn present_resources(
        &self,
        entry: &ProviderEntry,
        executable: &Path,
        definition: &ResourceDefinition,
        records: &[ResourceRecord],
    ) -> Vec<ProviderResourceView> {
        if records.is_empty() {
            return Vec::new();
        }
        let snapshots = records
            .iter()
            .map(|record| record.snapshot(&definition.resource_type))
            .collect::<Vec<_>>();
        let presented = self
            .worker(entry, executable)
            .await
            .invoke(
                "resource.present",
                serde_json::json!({
                    "resourceType": definition.resource_type,
                    "resources": snapshots,
                }),
                CancellationToken::new(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<ResourcePresentation>>(value).map_err(Error::from)
            });
        match presented {
            Ok(views) if views.len() == records.len() => records
                .iter()
                .zip(views)
                .map(|(record, view)| ProviderResourceView::from_record(record, view))
                .collect(),
            Ok(_) | Err(_) => records
                .iter()
                .map(|record| {
                    ProviderResourceView::from_record(
                        record,
                        ResourcePresentation {
                            display_name: record.key.clone(),
                            description: serde_json::Value::Null,
                            metrics: Vec::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    async fn channel_configured(&self, entry: &ProviderEntry, channel: &ChannelDefinition) -> bool {
        let provider_id = &entry.manifest.id;
        if channel.has_models {
            let models = self
                .inner
                .state
                .models(provider_id, &channel.id)
                .await
                .unwrap_or_default();
            if models.is_empty() {
                return false;
            }
        }
        match &channel.resource_type {
            Some(resource_type) => !self
                .inner
                .state
                .resources(provider_id, resource_type)
                .await
                .unwrap_or_default()
                .is_empty(),
            None => true,
        }
    }

    /// Refreshes the Provider model catalog using that resource type once a resource lands; failures are reported, not fatal.
    async fn sync_channel_models_for_resource(
        &self,
        entry: &ProviderEntry,
        executable: &Path,
        resource_type: &str,
    ) -> Option<String> {
        let mut errors = Vec::new();
        for channel in entry.definition.channels.clone() {
            if channel.resource_type.as_deref() != Some(resource_type) || !channel.has_models {
                continue;
            }
            if let Err(error) = self.sync_channel_models(entry, executable, &channel).await {
                errors.push(format!("{}: {error}", channel.id));
            }
        }
        (!errors.is_empty()).then(|| errors.join("; "))
    }

    async fn sync_channel_models(
        &self,
        entry: &ProviderEntry,
        executable: &Path,
        channel: &ChannelDefinition,
    ) -> Result<usize> {
        if !channel.has_models {
            return Err(Error::Config(format!(
                "provider channel '{}' does not enumerate models",
                channel.id
            )));
        }
        let provider_id = &entry.manifest.id;
        let resource = match &channel.resource_type {
            Some(resource_type) => {
                let record = self.select_resource(provider_id, resource_type).await?;
                Some(record.snapshot(resource_type))
            }
            None => None,
        };
        let value = self
            .worker(entry, executable)
            .await
            .invoke(
                "models.list",
                serde_json::json!({ "channelId": channel.id, "resource": resource }),
                CancellationToken::new(),
            )
            .await?;
        let definitions = value
            .as_array()
            .ok_or_else(|| Error::Protocol("provider models.list must return an array".into()))?;
        let mut models = Vec::with_capacity(definitions.len());
        let mut seen = std::collections::HashSet::new();
        for definition in definitions {
            let model = StoredModel::from_definition(definition)?;
            if seen.insert(model.id.clone()) {
                models.push(model);
            }
        }
        if models.is_empty() {
            return Err(Error::Provider(format!(
                "provider channel '{}' returned no models",
                channel.id
            )));
        }
        self.inner
            .state
            .replace_models(provider_id, &channel.id, &models, &entry.source_hash)
            .await?;
        Ok(models.len())
    }

    /// Re-syncs every configured catalog that was synced by different provider code, so model
    /// lists and picker options follow provider updates without a manual Sync. One attempt per
    /// catalog and provider source; failures keep the stored catalog.
    async fn refresh_stale_catalogs(&self, entries: &[ProviderEntry], executable: &Path) {
        let mut attempted = self.inner.catalog_refreshes.lock().await;
        for entry in entries {
            for channel in &entry.definition.channels {
                let attempt = format!("{}/{}/{}", entry.manifest.id, channel.id, entry.source_hash);
                if !channel.has_models || attempted.contains(&attempt) {
                    continue;
                }
                let source = self
                    .inner
                    .state
                    .models_source(&entry.manifest.id, &channel.id)
                    .await;
                if source.as_deref() == Some(entry.source_hash.as_str())
                    || !self.channel_configured(entry, channel).await
                {
                    continue;
                }
                attempted.insert(attempt);
                match self.sync_channel_models(entry, executable, channel).await {
                    Ok(count) => tracing::info!(
                        provider = %entry.manifest.id,
                        channel = %channel.id,
                        count,
                        "re-synced model catalog after provider code changed"
                    ),
                    Err(error) => tracing::warn!(
                        provider = %entry.manifest.id,
                        channel = %channel.id,
                        %error,
                        "model catalog re-sync after provider code change failed; keeping stored catalog"
                    ),
                }
            }
        }
    }

    /// Sorts resources by health and quota headroom: healthy with ample quota first, low quota next, cooling down by recovery time, and dead last.
    async fn select_resources(
        &self,
        provider_id: &str,
        resource_type: &str,
    ) -> Result<Vec<ResourceRecord>> {
        let records = self
            .inner
            .state
            .resources(provider_id, resource_type)
            .await?;
        if records.is_empty() {
            return Err(Error::Provider(format!(
                "provider '{provider_id}' has no '{resource_type}' resource; add one first"
            )));
        }
        Ok(rank_resources(records, now_ms()))
    }

    async fn select_resource(
        &self,
        provider_id: &str,
        resource_type: &str,
    ) -> Result<ResourceRecord> {
        self.select_resources(provider_id, resource_type)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| Error::Provider("no provider resource is available".into()))
    }

    async fn find_record(
        &self,
        provider_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<ResourceRecord> {
        self.inner
            .state
            .resources(provider_id, resource_type)
            .await?
            .into_iter()
            .find(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider resource {resource_id}")))
    }

    async fn update_session(
        &self,
        session_id: &str,
        session: Option<serde_json::Value>,
        poll_interval_ms: Option<i64>,
    ) {
        let mut sessions = self.inner.oauth_sessions.lock().await;
        if let Some(state) = sessions.get_mut(session_id) {
            if let Some(session) = session {
                state.session = session;
            }
            if let Some(interval) = poll_interval_ms {
                state.poll_interval_ms = interval;
            }
        }
    }

    fn executable(&self) -> Result<std::path::PathBuf> {
        self.inner
            .runtime
            .executable()
            .ok_or_else(|| Error::Config("provider runtime is not ready".into()))
    }

    async fn entries(&self, executable: &Path) -> Vec<ProviderEntry> {
        if let Some(entries) = self.inner.entries.read().await.as_ref() {
            return entries.clone();
        }
        let loaded = self.inner.catalog.entries(executable).await;
        *self.inner.entries.write().await = Some(loaded.clone());
        loaded
    }

    async fn find_entry(&self, executable: &Path, provider_id: &str) -> Result<ProviderEntry> {
        self.entries(executable)
            .await
            .into_iter()
            .find(|entry| entry.manifest.id == provider_id)
            .ok_or_else(|| Error::RunNotFound(format!("provider {provider_id}")))
    }

    async fn worker(&self, entry: &ProviderEntry, executable: &Path) -> Arc<ProviderWorker> {
        let mut workers = self.inner.workers.lock().await;
        workers
            .entry(entry.manifest.id.clone())
            .or_insert_with(|| {
                Arc::new(ProviderWorker::new(
                    entry,
                    executable.to_path_buf(),
                    self.inner.catalog.loader().clone(),
                    self.inner.store.clone(),
                    self.inner.headroom.clone(),
                ))
            })
            .clone()
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2Begin {
    session: serde_json::Value,
    user_code: String,
    verification_url: String,
    #[serde(default)]
    verification_url_complete: Option<String>,
    expires_at_ms: i64,
    poll_interval_ms: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2AuthorizationCodeBegin {
    session: serde_json::Value,
    authorization_url: String,
    expires_at_ms: i64,
    #[serde(default)]
    poll_interval_ms: Option<i64>,
}

fn oauth_random_secret() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "status")]
enum OAuth2Poll {
    #[serde(rename_all = "camelCase")]
    Pending {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    SlowDown {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Completed { resources: Vec<ResourceDraft> },
    #[serde(rename_all = "camelCase")]
    Denied {
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportParseResult {
    resources: Vec<ResourceDraft>,
    #[serde(default)]
    warnings: Vec<String>,
}

fn find_channel<'a>(entry: &'a ProviderEntry, channel_id: &str) -> Result<&'a ChannelDefinition> {
    entry
        .definition
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "provider '{}' channel {channel_id}",
                entry.manifest.id
            ))
        })
}

fn find_resource<'a>(
    entry: &'a ProviderEntry,
    resource_type: &str,
) -> Result<&'a ResourceDefinition> {
    entry
        .definition
        .resources
        .iter()
        .find(|resource| resource.resource_type == resource_type)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "provider '{}' resource type {resource_type}",
                entry.manifest.id
            ))
        })
}

const QUOTA_LOW_THRESHOLD_PERCENT: f64 = 15.0;

fn rank_resources(mut records: Vec<ResourceRecord>, now_ms: i64) -> Vec<ResourceRecord> {
    records.sort_by_key(|record| resource_rank_key(record, now_ms));
    records
}

fn resource_rank_key(record: &ResourceRecord, now_ms: i64) -> (u8, i64) {
    if record.state.is_ready(now_ms) {
        return (quota_tier(&record.private_data, now_ms), 0);
    }
    match &record.state {
        super::state::ResourceState::Cooling { retry_at_ms, .. } => {
            (3, retry_at_ms.unwrap_or(i64::MAX))
        }
        super::state::ResourceState::Invalid { .. } => (4, i64::MAX),
        super::state::ResourceState::Ready => (0, 0),
    }
}

fn quota_tier(private_data: &serde_json::Value, now_ms: i64) -> u8 {
    let Some(quota) = private_data
        .get("quota")
        .and_then(|value| value.as_object())
    else {
        return 0;
    };
    let cooling_active = quota
        .get("coolingUntilMs")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|until| until > now_ms);
    if cooling_active {
        return 2;
    }
    let mut any_window_active = false;
    let mut min_remaining: Option<f64> = None;
    for key in [
        "weekly", "daily", "monthly", "rolling", "fiveHour", "claude", "gemini",
    ] {
        let Some(window) = quota.get(key).and_then(|value| value.as_object()) else {
            continue;
        };
        let Some(remaining) = window
            .get("remainingPercent")
            .and_then(serde_json::Value::as_f64)
        else {
            continue;
        };
        let reset_expired = window
            .get("resetAtMs")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|reset| reset <= now_ms);
        if reset_expired {
            continue;
        }
        any_window_active = true;
        if remaining <= 0.0 {
            return 2;
        }
        min_remaining = Some(min_remaining.map_or(remaining, |current| current.min(remaining)));
    }
    if !any_window_active
        && quota
            .get("limitReached")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        return 2;
    }
    if min_remaining.is_some_and(|remaining| remaining < QUOTA_LOW_THRESHOLD_PERCENT) {
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::state::ResourceState;

    fn record(id: &str, state: ResourceState, private_data: serde_json::Value) -> ResourceRecord {
        ResourceRecord {
            id: id.into(),
            key: id.into(),
            private_data,
            state,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn ranks_healthy_resources_ahead_of_low_quota_cooling_and_invalid() {
        let now = 1_000_000;
        let records = vec![
            record(
                "invalid",
                ResourceState::Invalid { message: None },
                serde_json::json!({}),
            ),
            record(
                "cooling-late",
                ResourceState::Cooling {
                    retry_at_ms: Some(now + 120_000),
                    message: None,
                },
                serde_json::json!({}),
            ),
            record(
                "exhausted-quota",
                ResourceState::Ready,
                serde_json::json!({
                    "quota": {
                        "weekly": { "remainingPercent": 0, "resetAtMs": now + 3_600_000 },
                        "limitReached": true
                    }
                }),
            ),
            record(
                "low-quota",
                ResourceState::Ready,
                serde_json::json!({
                    "quota": {
                        "weekly": { "remainingPercent": 10, "resetAtMs": now + 3_600_000 },
                        "limitReached": false
                    }
                }),
            ),
            record(
                "healthy",
                ResourceState::Ready,
                serde_json::json!({
                    "quota": {
                        "weekly": { "remainingPercent": 73, "resetAtMs": now + 3_600_000 },
                        "limitReached": false
                    }
                }),
            ),
            record(
                "cooling-soon",
                ResourceState::Cooling {
                    retry_at_ms: Some(now + 30_000),
                    message: None,
                },
                serde_json::json!({}),
            ),
        ];
        let ranked: Vec<String> = rank_resources(records, now)
            .into_iter()
            .map(|item| item.id)
            .collect();
        assert_eq!(
            ranked,
            vec![
                "healthy",
                "low-quota",
                "exhausted-quota",
                "cooling-soon",
                "cooling-late",
                "invalid",
            ]
        );
    }
}
