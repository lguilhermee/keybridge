//! Runs one long-lived, sandboxed Deno process per active provider.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{mpsc, Mutex},
};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::ProviderEntry,
    definition::{file_url, ProviderDefinitionLoader},
    protocol::{HostMessage, WorkerMessage},
};
use crate::{protocol::CallRecorder, store::Store, Error, Result};

const INVOCATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_NETWORK_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 256 * 1024 * 1024;

/// Output of one streaming call: zero or more events followed by exactly one final result.
#[derive(Debug)]
pub enum WorkerStreamItem {
    Event(serde_json::Value),
    Result(Result<serde_json::Value>),
}

type Pending = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<WorkerStreamItem>>>>;
type StreamLines = Arc<Mutex<mpsc::Receiver<Result<String>>>>;

#[derive(Clone)]
pub struct ProviderWorker {
    inner: Arc<ProviderWorkerInner>,
}

struct ProviderWorkerInner {
    provider_id: String,
    executable: PathBuf,
    directory: PathBuf,
    entry: PathBuf,
    loader: ProviderDefinitionLoader,
    host: HostContext,
    process: Mutex<Option<WorkerProcess>>,
    pending: Pending,
}

struct WorkerProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct InvocationState {
    cancellation: CancellationToken,
    recorder: Option<CallRecorder>,
    recorder_claimed: AtomicBool,
}

/// Provider network request: two outbound shapes - standard reqwest or BoringSSL fingerprint emulation (wreq).
enum ProviderRequest {
    Standard(reqwest::RequestBuilder),
    Emulated(wreq::RequestBuilder),
}

impl ProviderRequest {
    fn timeout(self, timeout: Duration) -> Self {
        match self {
            Self::Standard(request) => Self::Standard(request.timeout(timeout)),
            Self::Emulated(request) => Self::Emulated(request.timeout(timeout)),
        }
    }

    /// Normalized into a reqwest response so the downstream fetch/stream paths are client-agnostic.
    async fn send(self) -> Result<reqwest::Response> {
        match self {
            Self::Standard(request) => Ok(request.send().await?),
            Self::Emulated(request) => request
                .send()
                .await
                .map(reqwest_response)
                .map_err(|error| Error::Provider(format!("emulated HTTP request: {error}"))),
        }
    }
}

/// Repackages a wreq response as a reqwest response: status and headers pass through, the body bridges into a stream.
fn reqwest_response(response: wreq::Response) -> reqwest::Response {
    use futures_util::TryStreamExt;
    let mut builder = axum::http::Response::builder().status(response.status());
    if let Some(headers) = builder.headers_mut() {
        *headers = response.headers().clone();
    }
    let body = reqwest::Body::wrap_stream(response.bytes_stream().map_err(std::io::Error::other));
    reqwest::Response::from(
        builder
            .body(body)
            .expect("bridged emulated response must build"),
    )
}

impl InvocationState {
    fn claim_recorder(&self) -> Option<CallRecorder> {
        self.recorder.as_ref().and_then(|recorder| {
            self.recorder_claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| recorder.clone())
        })
    }
}

#[derive(Clone)]
struct HostContext {
    provider_id: String,
    network_hosts: Arc<HashSet<String>>,
    emulated_hosts: Arc<HashSet<String>>,
    store: Store,
    headroom: crate::headroom::HeadroomRuntime,
    invocations: Arc<Mutex<HashMap<String, Arc<InvocationState>>>>,
    streams: Arc<Mutex<HashMap<String, StreamLines>>>,
}

impl ProviderWorker {
    pub fn new(
        provider: &ProviderEntry,
        executable: PathBuf,
        loader: ProviderDefinitionLoader,
        store: Store,
        headroom: crate::headroom::HeadroomRuntime,
    ) -> Self {
        let provider_id = provider.manifest.id.clone();
        Self {
            inner: Arc::new(ProviderWorkerInner {
                host: HostContext {
                    provider_id: provider_id.clone(),
                    network_hosts: Arc::new(
                        provider
                            .manifest
                            .permissions
                            .network
                            .iter()
                            .map(|host| host.to_ascii_lowercase())
                            .collect(),
                    ),
                    emulated_hosts: Arc::new(
                        provider
                            .manifest
                            .permissions
                            .tls_emulation
                            .iter()
                            .map(|host| host.to_ascii_lowercase())
                            .collect(),
                    ),
                    store,
                    headroom,
                    invocations: Arc::new(Mutex::new(HashMap::new())),
                    streams: Arc::new(Mutex::new(HashMap::new())),
                },
                provider_id,
                executable,
                directory: provider.directory.clone(),
                entry: provider.entry.clone(),
                loader,
                process: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    /// Unary call: events are dropped, waits for the final result under the shared timeout.
    pub async fn invoke(
        &self,
        method: &str,
        params: serde_json::Value,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value> {
        let mut items = self
            .invoke_streaming(method, params, cancellation, None)
            .await?;
        let result = tokio::time::timeout(INVOCATION_TIMEOUT, async {
            while let Some(item) = items.recv().await {
                if let WorkerStreamItem::Result(result) = item {
                    return result;
                }
            }
            Err(Error::Provider(format!(
                "provider '{}' worker stopped",
                self.inner.provider_id
            )))
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => Err(Error::Provider(format!(
                "provider '{}' invocation timed out",
                self.inner.provider_id
            ))),
        }
    }

    /// Streaming call: events are forwarded in order and the stream ends with exactly one Result.
    /// Cancellation propagates through the token to the Worker and its pending host network requests.
    pub async fn invoke_streaming(
        &self,
        method: &str,
        params: serde_json::Value,
        cancellation: CancellationToken,
        recorder: Option<CallRecorder>,
    ) -> Result<mpsc::UnboundedReceiver<WorkerStreamItem>> {
        let id = uuid::Uuid::new_v4().to_string();
        let request_cancellation = CancellationToken::new();
        self.inner.host.invocations.lock().await.insert(
            id.clone(),
            Arc::new(InvocationState {
                cancellation: request_cancellation.clone(),
                recorder,
                recorder_claimed: AtomicBool::new(false),
            }),
        );
        let (sender, receiver) = mpsc::unbounded_channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id.clone(), sender.clone());
        let send_result = async {
            let stdin = self.stdin().await?;
            write_message(
                &stdin,
                &HostMessage::Request {
                    id: &id,
                    method,
                    params: &params,
                },
            )
            .await
        }
        .await;
        if let Err(error) = send_result {
            self.cleanup(&id).await;
            return Err(error);
        }

        // Cancellation watch: notifies the Worker and aborts the host network call pending on this request.
        let inner = self.inner.clone();
        let request_id = id.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    request_cancellation.cancel();
                    if let Some(process) = inner.process.lock().await.as_ref() {
                        let _ = write_message(&process.stdin, &HostMessage::Cancel { id: &request_id }).await;
                    }
                    let _ = sender.send(WorkerStreamItem::Result(Err(Error::Cancelled)));
                    inner.pending.lock().await.remove(&request_id);
                    inner.host.invocations.lock().await.remove(&request_id);
                }
                _ = sender.closed() => {
                    inner.host.invocations.lock().await.remove(&request_id);
                }
            }
        });
        Ok(receiver)
    }

    pub async fn stop(&self) {
        if let Some(mut process) = self.inner.process.lock().await.take() {
            let _ = process.child.kill().await;
        }
        fail_pending(&self.inner.pending, "provider worker stopped").await;
    }

    async fn cleanup(&self, id: &str) {
        self.inner.pending.lock().await.remove(id);
        self.inner.host.invocations.lock().await.remove(id);
    }

    async fn stdin(&self) -> Result<Arc<Mutex<ChildStdin>>> {
        let mut process = self.inner.process.lock().await;
        let dead = match process.as_mut() {
            Some(current) => current
                .child
                .try_wait()
                .map_err(|error| {
                    Error::Config(format!("cannot check provider worker status: {error}"))
                })?
                .is_some(),
            None => true,
        };
        if dead {
            *process = Some(self.spawn().await?);
        }
        Ok(process
            .as_ref()
            .expect("provider worker was started")
            .stdin
            .clone())
    }

    async fn spawn(&self) -> Result<WorkerProcess> {
        let entry_url = file_url(&self.inner.entry)?;
        let mut command = tokio::process::Command::new(&self.inner.executable);
        super::detach_console(&mut command);
        command
            .arg("run")
            .arg("--quiet")
            .arg("--no-config")
            .arg("--no-lock")
            .arg("--no-npm")
            .arg("--no-remote")
            .arg("--no-prompt")
            .arg(format!("--allow-read={}", self.inner.directory.display()))
            .arg(format!(
                "--allow-read={}",
                self.inner.loader.sdk_dir().display()
            ))
            .arg(format!(
                "--import-map={}",
                self.inner.loader.import_map().display()
            ))
            .arg(self.inner.loader.worker_path())
            .arg(entry_url.as_str())
            .env("DENO_DIR", self.inner.loader.deno_dir())
            .env("DENO_NO_UPDATE_CHECK", "1")
            .current_dir(&self.inner.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            Error::Config(format!(
                "cannot start provider worker {}: {error}",
                self.inner.executable.display()
            ))
        })?;
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                Error::Config("cannot open provider worker stdin".into())
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Config("cannot open provider worker stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Config("cannot open provider worker stderr".into()))?;
        spawn_stdout_reader(
            self.inner.provider_id.clone(),
            stdout,
            stdin.clone(),
            self.inner.pending.clone(),
            self.inner.host.clone(),
        );
        spawn_stderr_reader(self.inner.provider_id.clone(), stderr);
        Ok(WorkerProcess { child, stdin })
    }
}

fn spawn_stdout_reader(
    provider_id: String,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    host: HostContext,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let message = match serde_json::from_str::<WorkerMessage>(&line) {
                Ok(message) => message,
                Err(error) => {
                    tracing::warn!(provider = %provider_id, %error, "provider worker wrote an invalid message");
                    continue;
                }
            };
            match message {
                WorkerMessage::Result { id, result, error } => {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let value = match error {
                            Some(error) => Err(Error::Provider(format!(
                                "provider '{provider_id}': {error}"
                            ))),
                            None => Ok(result),
                        };
                        let _ = sender.send(WorkerStreamItem::Result(value));
                    }
                }
                WorkerMessage::Event { id, event } => {
                    if let Some(sender) = pending.lock().await.get(&id) {
                        let _ = sender.send(WorkerStreamItem::Event(event));
                    }
                }
                WorkerMessage::HostCall {
                    id,
                    request_id,
                    method,
                    params,
                } => {
                    let host = host.clone();
                    let stdin = stdin.clone();
                    tokio::spawn(async move {
                        let result = host.call(&request_id, &method, params).await;
                        match result {
                            Ok(result) => {
                                let _ = write_message(
                                    &stdin,
                                    &HostMessage::HostResult {
                                        id: &id,
                                        result: &result,
                                    },
                                )
                                .await;
                            }
                            Err(error) => {
                                let text = error.to_string();
                                let _ = write_message(
                                    &stdin,
                                    &HostMessage::HostError {
                                        id: &id,
                                        error: &text,
                                    },
                                )
                                .await;
                            }
                        }
                    });
                }
            }
        }
        fail_pending(&pending, &format!("provider '{provider_id}' worker exited")).await;
    });
}

fn spawn_stderr_reader(provider_id: String, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!(provider = %provider_id, message = %line, "provider worker stderr");
        }
    });
}

async fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &HostMessage<'_>) -> Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| Error::Config(format!("cannot write to provider worker: {error}")))?;
    stdin
        .flush()
        .await
        .map_err(|error| Error::Config(format!("cannot flush provider worker stdin: {error}")))?;
    Ok(())
}

async fn fail_pending(pending: &Pending, message: &str) {
    for (_, sender) in std::mem::take(&mut *pending.lock().await) {
        let _ = sender.send(WorkerStreamItem::Result(Err(Error::Provider(
            message.into(),
        ))));
    }
}

fn recorded_network_request(
    params: &serde_json::Value,
) -> Result<(serde_json::Value, serde_json::Value)> {
    let mut recorded_headers = serde_json::Map::new();
    if let Some(headers) = params.get("headers").and_then(serde_json::Value::as_object) {
        for (name, value) in headers {
            let value = value.as_str().ok_or_else(|| {
                Error::Config(format!("provider HTTP header '{name}' must be a string"))
            })?;
            if !crate::model::is_sensitive_header(name) {
                recorded_headers.insert(name.clone(), value.into());
            }
        }
    }
    let body = if params.get("bodyBase64").is_some() {
        // Framed binary bodies may contain credentials inside their metadata.
        // Record their size, never an opaque base64 copy of those credentials.
        serde_json::json!({ "binaryBytes": network_request_body(params)?.unwrap().len() })
    } else {
        params
            .get("body")
            .and_then(serde_json::Value::as_str)
            .map(|body| serde_json::from_str(body).unwrap_or_else(|_| body.into()))
            .unwrap_or(serde_json::Value::Null)
    };
    Ok((serde_json::Value::Object(recorded_headers), body))
}

fn network_request_body(params: &serde_json::Value) -> Result<Option<Vec<u8>>> {
    match (params.get("body"), params.get("bodyBase64")) {
        (Some(_), Some(_)) => Err(Error::Config(
            "provider request cannot contain both body and bodyBase64".into(),
        )),
        (Some(body), None) => Ok(Some(
            body.as_str()
                .ok_or_else(|| Error::Config("provider body must be a string".into()))?
                .as_bytes()
                .to_vec(),
        )),
        (None, Some(body)) => {
            let encoded = body
                .as_str()
                .ok_or_else(|| Error::Config("provider bodyBase64 must be a string".into()))?;
            if encoded.len() as u64 > MAX_NETWORK_RESPONSE_BYTES * 4 / 3 + 4 {
                return Err(Error::Config(
                    "provider binary request is larger than allowed".into(),
                ));
            }
            let decoded = STANDARD
                .decode(encoded)
                .map_err(|_| Error::Config("provider bodyBase64 is invalid".into()))?;
            if decoded.len() as u64 > MAX_NETWORK_RESPONSE_BYTES {
                return Err(Error::Config(
                    "provider binary request is larger than allowed".into(),
                ));
            }
            Ok(Some(decoded))
        }
        (None, None) => Ok(None),
    }
}

impl HostContext {
    async fn call(
        &self,
        request_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        match method {
            "network.fetch" => self.fetch(request_id, params).await,
            "network.stream.open" => self.stream_open(request_id, params).await,
            "network.stream.read" => self.stream_read(params).await,
            "network.stream.close" => {
                self.streams
                    .lock()
                    .await
                    .remove(required_string(&params, "streamId")?);
                Ok(serde_json::Value::Null)
            }
            _ => Err(Error::Protocol(format!(
                "unsupported provider host method: {method}"
            ))),
        }
    }

    async fn request(
        &self,
        request_id: &str,
        params: &serde_json::Value,
    ) -> Result<(ProviderRequest, CancellationToken, Option<CallRecorder>)> {
        let raw_url = required_string(params, "url")?;
        let url = url::Url::parse(raw_url)
            .map_err(|error| Error::Config(format!("invalid provider network URL: {error}")))?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::Config(
                "provider network URL must be HTTPS without credentials".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| Error::Config("provider network URL has no host".into()))?
            .to_ascii_lowercase();
        if !self.network_hosts.contains(&host) {
            return Err(Error::Config(format!(
                "provider '{}' cannot access host '{host}'",
                self.provider_id
            )));
        }
        let method = params
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("GET")
            .parse::<reqwest::Method>()
            .map_err(|error| Error::Config(format!("invalid provider HTTP method: {error}")))?;
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(values) = params.get("headers").and_then(serde_json::Value::as_object) {
            for (name, value) in values {
                let value = value.as_str().ok_or_else(|| {
                    Error::Config(format!("provider HTTP header '{name}' must be a string"))
                })?;
                headers.append(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
                        Error::Config(format!("invalid provider HTTP header '{name}': {error}"))
                    })?,
                    value
                        .parse::<reqwest::header::HeaderValue>()
                        .map_err(|error| {
                            Error::Config(format!(
                                "invalid provider HTTP header '{name}' value: {error}"
                            ))
                        })?,
                );
            }
        }
        let body = network_request_body(params)?;
        let invocation = self.invocations.lock().await.get(request_id).cloned();
        let body = match (body, invocation.is_some()) {
            (Some(bytes), true) => Some(
                self.compress_model_body(request_id, bytes, &mut headers)
                    .await,
            ),
            (body, _) => body,
        };
        let request = if self.emulated_hosts.contains(&host) {
            let client = crate::network::emulated_client(&self.store).await?;
            let mut request = client.request(method, url.as_str());
            if !headers.is_empty() {
                request = request.headers(headers);
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            ProviderRequest::Emulated(request)
        } else {
            let client = crate::network::client_builder(&self.store)
                .await?
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .build()?;
            let mut request = client.request(method, url);
            if !headers.is_empty() {
                request = request.headers(headers);
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            ProviderRequest::Standard(request)
        };
        let cancellation = invocation
            .as_ref()
            .map(|state| state.cancellation.clone())
            .unwrap_or_default();
        let recorder = invocation.and_then(|state| state.claim_recorder());
        if let Some(recorder) = &recorder {
            let (headers, body) = recorded_network_request(params)?;
            recorder.request(headers, &body).await?;
        }
        Ok((request, cancellation, recorder))
    }

    /// Model requests invoked through this worker get their JSON body
    /// compressed through the Headroom gateway. Non-model payloads and every
    /// failure keep the original bytes untouched.
    async fn compress_model_body(
        &self,
        request_id: &str,
        body: Vec<u8>,
        headers: &mut reqwest::header::HeaderMap,
    ) -> Vec<u8> {
        let mut value: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return body,
        };
        let model_request = value.as_object().is_some_and(|object| {
            object
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some()
                && (object
                    .get("messages")
                    .and_then(serde_json::Value::as_array)
                    .is_some()
                    || object
                        .get("input")
                        .and_then(serde_json::Value::as_array)
                        .is_some())
        });
        if !model_request {
            return body;
        }
        let Some(route) = self.headroom.route(request_id).await else {
            return body;
        };
        let mut extra = reqwest::header::HeaderMap::new();
        crate::headroom::compress_body(&reqwest::Client::new(), &route, &mut value, &mut extra)
            .await;
        headers.extend(extra);
        serde_json::to_vec(&value).unwrap_or(body)
    }

    async fn fetch(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let request = request.timeout(Duration::from_secs(60));
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_NETWORK_RESPONSE_BYTES)
        {
            return Err(Error::Provider(
                "provider network response is larger than allowed".into(),
            ));
        }
        let headers = header_map(&response);
        let body = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            body = response.bytes() => body?,
        };
        if body.len() as u64 > MAX_NETWORK_RESPONSE_BYTES {
            return Err(Error::Provider(
                "provider network response is larger than allowed".into(),
            ));
        }
        if let Some(recorder) = &recorder {
            recorder.response_chunk(&body).await?;
        }
        Ok(
            serde_json::json!({ "status": status, "headers": headers, "body": String::from_utf8_lossy(&body) }),
        )
    }

    /// Opens a streaming response: returns status and headers immediately, the body is pulled line by line via stream.read.
    async fn stream_open(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        let headers = header_map(&response);
        let (sender, receiver) = mpsc::channel::<Result<String>>(256);
        let binary = params
            .get("binary")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        tokio::spawn(forward_network_stream(
            response,
            sender,
            recorder,
            binary,
            cancellation,
        ));
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.streams
            .lock()
            .await
            .insert(stream_id.clone(), Arc::new(Mutex::new(receiver)));
        Ok(serde_json::json!({
            "streamId": stream_id,
            "status": status,
            "headers": headers,
        }))
    }

    async fn stream_read(&self, params: serde_json::Value) -> Result<serde_json::Value> {
        let stream_id = required_string(&params, "streamId")?;
        let lines_handle = self
            .streams
            .lock()
            .await
            .get(stream_id)
            .cloned()
            .ok_or_else(|| Error::Protocol(format!("unknown provider stream: {stream_id}")))?;
        let mut receiver = lines_handle.lock().await;
        let mut lines = Vec::new();
        match receiver.recv().await {
            Some(Ok(line)) => lines.push(line),
            Some(Err(error)) => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Err(error);
            }
            None => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Ok(serde_json::json!({ "lines": [], "done": true }));
            }
        }
        // Drains already-ready lines to cut round trips.
        while lines.len() < 256 {
            match receiver.try_recv() {
                Ok(Ok(line)) => lines.push(line),
                Ok(Err(error)) => {
                    drop(receiver);
                    self.streams.lock().await.remove(stream_id);
                    return Err(error);
                }
                Err(_) => break,
            }
        }
        Ok(serde_json::json!({ "lines": lines, "done": false }))
    }
}

fn header_map(response: &reqwest::Response) -> std::collections::BTreeMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn required_string<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Error::Protocol(format!("provider host call requires string '{key}'")))
}

/// Own the HTTP body across every queue send so Stop also drops a stream
/// whose provider stopped reading while its output queue was full.
async fn forward_network_stream(
    response: reqwest::Response,
    sender: mpsc::Sender<Result<String>>,
    recorder: Option<CallRecorder>,
    binary: bool,
    cancellation: CancellationToken,
) {
    let pump = async {
        use futures_util::StreamExt;
        let mut body = response.bytes_stream();
        let mut buffered = Vec::<u8>::new();
        let mut total = 0_u64;
        loop {
            let chunk = tokio::select! {
                _ = sender.closed() => return,
                chunk = body.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = sender.send(Err(Error::from(error))).await;
                    return;
                }
            };
            total += chunk.len() as u64;
            if total > MAX_STREAM_BYTES {
                let _ = sender
                    .send(Err(Error::Provider(
                        "provider network stream is larger than allowed".into(),
                    )))
                    .await;
                return;
            }
            if let Some(recorder) = &recorder {
                if let Err(error) = recorder.response_chunk(&chunk).await {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            }
            if binary {
                for bytes in chunk.chunks(64 * 1024) {
                    if sender.send(Ok(STANDARD.encode(bytes))).await.is_err() {
                        return;
                    }
                }
                continue;
            }
            buffered.extend_from_slice(&chunk);
            while let Some(position) = buffered.iter().position(|byte| *byte == b'\n') {
                let mut line = buffered.drain(..=position).collect::<Vec<u8>>();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if sender
                    .send(Ok(String::from_utf8_lossy(&line).into_owned()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
        if !buffered.is_empty() {
            let _ = sender
                .send(Ok(String::from_utf8_lossy(&buffered).into_owned()))
                .await;
        }
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => {},
        _ = pump => {},
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn stop_closes_provider_http_body_even_when_the_output_queue_is_full() {
        use super::*;
        let (network, network_rx) =
            mpsc::channel::<std::result::Result<bytes::Bytes, std::io::Error>>(1);
        let body =
            reqwest::Body::wrap_stream(tokio_stream::wrappers::ReceiverStream::new(network_rx));
        let response = reqwest::Response::from(axum::http::Response::new(body));
        let (output, _output_rx) = mpsc::channel(1);
        let cancellation = CancellationToken::new();
        // A single network chunk contains more lines than the provider can accept.
        network
            .send(Ok(bytes::Bytes::from_static(b"first\nsecond\nthird\n")))
            .await
            .unwrap();
        let pump = forward_network_stream(response, output, None, false, cancellation.clone());
        tokio::pin!(pump);
        assert!(futures_util::poll!(&mut pump).is_pending());
        assert!(!network.is_closed());
        cancellation.cancel();

        tokio::time::timeout(Duration::from_secs(1), pump)
            .await
            .expect("Stop left the provider HTTP body alive behind a full queue");
        assert!(
            network.is_closed(),
            "the provider connection must be dropped"
        );
    }
    use crate::{
        model::{NewLlmCall, ProtocolType},
        protocol::{CallRecorder, FinishReason},
        store::Store,
    };

    use super::*;

    async fn recorder(detailed: bool, call_id: &str) -> (tempfile::TempDir, Store, CallRecorder) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        store.set_detailed_logging(detailed).await.unwrap();
        let recorder = CallRecorder::start(
            store.clone(),
            NewLlmCall {
                call_id: call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "provider:test/channel/model".into(),
                protocol_type: ProtocolType::Provider,
                endpoint_url: "provider://test/channel".into(),
                model_id: "model".into(),
                display_name: "Model".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            },
        )
        .await
        .unwrap();
        (directory, store, recorder)
    }

    fn network_params() -> serde_json::Value {
        serde_json::json!({
            "url": "https://example.com/v1/responses",
            "method": "POST",
            "headers": {
                "Authorization": "Bearer secret",
                "X-Api-Key": "secret-key",
                "Cookie": "session=secret",
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            },
            "body": "{\"model\":\"test\",\"stream\":true}"
        })
    }

    async fn host_with_recorder(store: Store, recorder: CallRecorder) -> HostContext {
        let invocations = Arc::new(Mutex::new(HashMap::new()));
        invocations.lock().await.insert(
            "invocation".into(),
            Arc::new(InvocationState {
                cancellation: CancellationToken::new(),
                recorder: Some(recorder),
                recorder_claimed: AtomicBool::new(false),
            }),
        );
        HostContext {
            provider_id: "test".into(),
            network_hosts: Arc::new(HashSet::from(["example.com".into()])),
            emulated_hosts: Arc::new(HashSet::new()),
            store: store.clone(),
            headroom: crate::headroom::HeadroomRuntime::new(
                store.clone(),
                crate::network::NetworkClients::new(store.clone()),
            ),
            invocations,
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[test]
    fn recorded_provider_request_omits_sensitive_headers() {
        let (headers, body) = recorded_network_request(&network_params()).unwrap();

        assert_eq!(
            headers,
            serde_json::json!({
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            })
        );
        assert_eq!(body, serde_json::json!({ "model": "test", "stream": true }));
    }

    #[test]
    fn binary_requests_preserve_bytes_without_recording_credentials() {
        let bytes = b"\0\xff\nmetadata-secret";
        let params = serde_json::json!({ "bodyBase64": STANDARD.encode(bytes) });
        assert_eq!(network_request_body(&params).unwrap().unwrap(), bytes);
        let (_, recorded) = recorded_network_request(&params).unwrap();
        assert_eq!(recorded, serde_json::json!({ "binaryBytes": bytes.len() }));
        assert!(
            network_request_body(&serde_json::json!({ "body": "a", "bodyBase64": "Yg==" }))
                .is_err()
        );
        assert!(network_request_body(&serde_json::json!({ "bodyBase64": "!invalid" })).is_err());
    }

    #[tokio::test]
    async fn detailed_provider_network_recording_persists_request_and_raw_response() {
        let (_directory, store, recorder) = recorder(true, "detailed-provider").await;
        let host = host_with_recorder(store.clone(), recorder.clone()).await;
        let params = network_params();
        let (_, _, first_recorder) = host.request("invocation", &params).await.unwrap();
        let (_, _, second_recorder) = host.request("invocation", &params).await.unwrap();
        let (_, body) = recorded_network_request(&params).unwrap();

        assert!(first_recorder.is_some());
        assert!(second_recorder.is_none());
        recorder.response_headers(200).await.unwrap();
        recorder
            .response_chunk(b"data: {\"type\":\"response.created\"}\n\n")
            .await
            .unwrap();
        recorder.response_chunk(b"data: [DONE]\n\n").await.unwrap();
        recorder.completed(FinishReason::Stop).await.unwrap();

        let request = store
            .llm_call_request("detailed-provider")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            request.headers,
            serde_json::json!({
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            })
        );
        assert_eq!(request.body, body);
        let chunks = store.llm_call_chunks("detailed-provider").await.unwrap();
        let expected_response = "data: {\"type\":\"response.created\"}\n\ndata: [DONE]\n\n";
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.data.as_str())
                .collect::<String>(),
            expected_response
        );
        let summary = store.llm_call("detailed-provider").await.unwrap().unwrap();
        assert_eq!(summary.http_status, Some(200));
        assert_eq!(summary.stream_event_count, 2);
        assert_eq!(summary.response_bytes, expected_response.len() as i64);
        assert!(summary.detailed);
    }

    #[tokio::test]
    async fn standard_provider_network_recording_keeps_metrics_without_payloads() {
        let (_directory, store, recorder) = recorder(false, "standard-provider").await;
        let host = host_with_recorder(store.clone(), recorder.clone()).await;
        let params = network_params();
        let (_, body) = recorded_network_request(&params).unwrap();
        let request_bytes = serde_json::to_string(&body).unwrap().len() as i64;
        let response = b"data: [DONE]\n\n";

        let (_, _, observed) = host.request("invocation", &params).await.unwrap();
        assert!(observed.is_some());
        recorder.response_headers(204).await.unwrap();
        recorder.response_chunk(response).await.unwrap();
        recorder.completed(FinishReason::Stop).await.unwrap();

        assert!(store
            .llm_call_request("standard-provider")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .llm_call_chunks("standard-provider")
            .await
            .unwrap()
            .is_empty());
        let summary = store.llm_call("standard-provider").await.unwrap().unwrap();
        assert_eq!(summary.http_status, Some(204));
        assert_eq!(summary.request_bytes, Some(request_bytes));
        assert_eq!(summary.response_bytes, response.len() as i64);
        assert_eq!(summary.stream_event_count, 1);
        assert!(!summary.detailed);
    }
}
