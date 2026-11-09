//! Runs the Headroom compression sidecar and rewrites provider request bodies
//! through its gateway-mode `POST /v1/compress` endpoint.
//!
//! Headroom never sees the provider response and never chooses the upstream:
//! it returns a complete provider body that we forward ourselves. Every
//! failure fails open so an unreachable or missing sidecar degrades to
//! uncompressed traffic instead of breaking calls.
use std::{
    io::ErrorKind,
    net::SocketAddr,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use tokio::{net::TcpStream, process::Child, sync::Mutex};

use crate::{network::NetworkClients, store::Store, Error, Result};

const COMPRESS_TIMEOUT: Duration = Duration::from_secs(120);
const SPAWN_RETRY_BACKOFF: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug)]
pub struct HeadroomRoute {
    pub endpoint: String,
    pub session_id: String,
}

/// Public status shown on the settings page.
#[derive(Clone, Debug, Serialize)]
pub struct HeadroomStatus {
    pub enabled: bool,
    pub port: u16,
    pub state: &'static str,
    pub detail: Option<String>,
    pub installing: bool,
}

/// Compresses `body` in place through the Headroom gateway contract.
///
/// The provider body is sent as the request half: `messages` (or `input` for
/// the Responses API) is compressed while every other field passes through
/// into the returned `body`. Headers Headroom asks the gateway to set are
/// merged into `provider_headers`.
pub async fn compress_body(
    client: &reqwest::Client,
    route: &HeadroomRoute,
    body: &mut Value,
    provider_headers: &mut HeaderMap,
) {
    match try_compress(client, route, body).await {
        Ok(outcome) => {
            *body = outcome.body;
            provider_headers.extend(outcome.headers);
        }
        Err(error) => {
            tracing::warn!(%error, "headroom compression failed; forwarding uncompressed body");
        }
    }
}

struct CompressOutcome {
    body: Value,
    headers: HeaderMap,
}

async fn try_compress(
    client: &reqwest::Client,
    route: &HeadroomRoute,
    body: &Value,
) -> Result<CompressOutcome> {
    let object = body
        .as_object()
        .ok_or_else(|| Error::Provider("provider request body is not an object".into()))?;
    if object.get("model").and_then(Value::as_str).is_none() {
        return Err(Error::Provider("provider request body has no model".into()));
    }
    // Responses bodies keep `input`: Headroom compresses them through a native
    // view, while a `messages` rename makes it treat the transcript as chat and
    // add Anthropic `cache_control` markers that the Responses API rejects.
    let transcript = ["messages", "input"]
        .into_iter()
        .find(|key| object.get(*key).and_then(Value::as_array).is_some())
        .ok_or_else(|| Error::Provider("provider request body has no messages".into()))?;
    let mut payload = object.clone();
    let session_id = route.session_id.trim();
    if !session_id.is_empty() && session_id.chars().count() <= 256 {
        payload.insert(
            "config".into(),
            serde_json::json!({ "session_id": session_id }),
        );
    }
    // Streaming calls cannot re-drive and we never relay the response half, so
    // every obligation that needs the provider answer stays disabled.
    payload.insert(
        "gateway".into(),
        serde_json::json!({ "can_redrive": false, "can_relay_response": false }),
    );

    let response = client
        .post(format!("{}/v1/compress", route.endpoint))
        .json(&payload)
        .timeout(COMPRESS_TIMEOUT)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(Error::Provider(format!(
            "headroom compress failed ({status}): {detail}"
        )));
    }
    let value: Value = response.json().await?;
    let compressed = value
        .get("body")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| Error::Provider("headroom response has no body".into()))?;
    if compressed
        .get(transcript)
        .and_then(Value::as_array)
        .is_none()
    {
        return Err(Error::Provider(format!(
            "headroom response lost the compressed {transcript}"
        )));
    }
    let mut headers = HeaderMap::new();
    if let Some(extra) = value.get("headers").and_then(Value::as_object) {
        for (name, value) in extra {
            if let (Ok(name), Some(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                value
                    .as_str()
                    .and_then(|value| HeaderValue::from_str(value).ok()),
            ) {
                headers.append(name, value);
            }
        }
    }
    Ok(CompressOutcome {
        body: Value::Object(compressed),
        headers,
    })
}

#[derive(Default)]
struct ProcessState {
    child: Option<Child>,
    port: u16,
    managed: bool,
    last_error: Option<String>,
    last_spawn_failure: Option<Instant>,
    binary_missing: bool,
    installing: bool,
}

/// Owns the optional `headroom proxy` sidecar. A listener already bound to the
/// configured port is adopted as external and is never killed.
#[derive(Clone)]
pub struct HeadroomRuntime {
    store: Store,
    state: Arc<Mutex<ProcessState>>,
}

impl HeadroomRuntime {
    pub fn new(store: Store, _clients: NetworkClients) -> Self {
        Self {
            store,
            state: Arc::new(Mutex::new(ProcessState::default())),
        }
    }

    /// Resolves the compression route for one request, starting the sidecar
    /// lazily when the feature is enabled. Returns `None` when disabled or
    /// unavailable; callers then forward the body unchanged.
    pub async fn route(&self, session_id: &str) -> Option<HeadroomRoute> {
        let settings = self.store.headroom_settings().await.ok()?;
        if !settings.enabled {
            return None;
        }
        self.ensure_running(settings.port).await.ok()?;
        Some(HeadroomRoute {
            endpoint: endpoint(settings.port),
            session_id: session_id.to_owned(),
        })
    }

    pub async fn status(&self) -> HeadroomStatus {
        let settings = self.store.headroom_settings().await.unwrap_or_default();
        let mut state = self.state.lock().await;
        reap_exited(&mut state);
        let (state_name, detail) = if !settings.enabled {
            ("disabled", None)
        } else if state.binary_missing {
            (
                "not_installed",
                Some("headroom executable was not found".to_owned()),
            )
        } else if state.child.is_some() || state.last_error.is_none() {
            if port_open(settings.port).await {
                ("running", None)
            } else if let Some(error) = state.last_error.clone() {
                ("failed", Some(error))
            } else {
                ("starting", None)
            }
        } else {
            ("failed", state.last_error.clone())
        };
        HeadroomStatus {
            enabled: settings.enabled,
            port: settings.port,
            state: state_name,
            detail,
            installing: state.installing,
        }
    }

    /// Applies persisted settings: starts, restarts, or stops the sidecar to
    /// match. Called after every settings write. Spawn failures are reported
    /// through the returned status instead of failing the settings save.
    pub async fn apply(&self) -> Result<HeadroomStatus> {
        let settings = self.store.headroom_settings().await?;
        if settings.enabled {
            let _ = self.ensure_running(settings.port).await;
        } else {
            self.stop_managed().await;
        }
        Ok(self.status().await)
    }

    /// Installs the Headroom CLI with the first available Python tool runner,
    /// then clears the missing-binary marker so the next request can spawn it.
    pub async fn install(&self) -> Result<HeadroomStatus> {
        {
            let mut state = self.state.lock().await;
            if state.installing {
                return Err(Error::Config(
                    "a headroom installation is already running".into(),
                ));
            }
            state.installing = true;
        }
        let result = self.install_inner().await;
        let mut state = self.state.lock().await;
        state.installing = false;
        match result {
            Ok(()) => {
                state.binary_missing = false;
                drop(state);
                self.apply().await
            }
            Err(error) => Err(error),
        }
    }

    async fn install_inner(&self) -> Result<()> {
        let installers: [(&str, &[&str]); 2] = [
            (
                "uv",
                &["tool", "install", "--python", "3.13", HEADROOM_PACKAGE],
            ),
            (
                "pipx",
                &["install", "--python", "python3.13", HEADROOM_PACKAGE],
            ),
        ];
        let mut last_error = String::from("no Python tool runner (uv or pipx) is installed");
        for (program, args) in installers {
            match run_installer(program, args).await {
                Ok(()) => return Ok(()),
                Err(InstallError::Missing) => {
                    last_error = format!("{program} is not installed");
                    continue;
                }
                Err(InstallError::Failed(detail)) => {
                    return Err(Error::Config(format!(
                        "headroom installation via {program} failed: {detail}"
                    )));
                }
            }
        }
        Err(Error::Config(last_error))
    }

    /// Stops the managed sidecar on server shutdown.
    pub async fn shutdown(&self) {
        self.stop_managed().await;
    }

    async fn ensure_running(&self, port: u16) -> Result<()> {
        if port_open(port).await {
            let mut state = self.state.lock().await;
            // An external listener owns the port; adopt it.
            if state.child.is_none() {
                state.managed = false;
            }
            state.port = port;
            state.last_error = None;
            return Ok(());
        }
        let mut state = self.state.lock().await;
        reap_exited(&mut state);
        if state.port != port {
            // The configured port moved: retire the previous child.
            stop_child(&mut state).await;
            state.port = port;
        }
        if state.child.is_some() {
            return Ok(());
        }
        if state.binary_missing {
            return Err(Error::Config("headroom executable was not found".into()));
        }
        if state
            .last_spawn_failure
            .is_some_and(|failed| failed.elapsed() < SPAWN_RETRY_BACKOFF)
        {
            return Err(Error::Config(
                state
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "headroom proxy is still starting".into()),
            ));
        }
        match spawn_proxy(port).await {
            Ok(child) => {
                state.child = Some(child);
                state.managed = true;
                state.last_error = None;
                Ok(())
            }
            Err(error) => {
                if error.kind() == ErrorKind::NotFound {
                    state.binary_missing = true;
                }
                state.last_spawn_failure = Some(Instant::now());
                state.last_error = Some(error.to_string());
                Err(Error::Config(format!(
                    "headroom proxy could not start: {error}"
                )))
            }
        }
    }

    async fn stop_managed(&self) {
        let mut state = self.state.lock().await;
        if state.managed {
            stop_child(&mut state).await;
        } else {
            state.child = None;
        }
    }
}

const HEADROOM_PACKAGE: &str = "headroom-ai[proxy]";

fn endpoint(port: u16) -> String {
    format!("http://{}", SocketAddr::from(([127, 0, 0, 1], port)))
}

async fn port_open(port: u16) -> bool {
    TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .is_ok()
}

fn reap_exited(state: &mut ProcessState) {
    let Some(child) = state.child.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            state.child = None;
            state.last_error = Some(format!("headroom proxy exited with {status}"));
        }
        Ok(None) => {}
        Err(error) => {
            state.child = None;
            state.last_error = Some(format!("headroom proxy wait failed: {error}"));
        }
    }
}

async fn stop_child(state: &mut ProcessState) {
    if let Some(mut child) = state.child.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    state.managed = false;
}

/// Executable candidates: PATH first, then the uv/pipx tool bin directory that
/// is frequently absent from a GUI app's PATH.
fn executable_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = vec![std::path::PathBuf::from("headroom")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(if cfg!(windows) {
            "headroom.exe"
        } else {
            "headroom"
        }));
    }
    candidates
}

async fn spawn_proxy(port: u16) -> std::io::Result<Child> {
    let mut last_error = std::io::Error::new(ErrorKind::NotFound, "headroom not found");
    for executable in executable_candidates() {
        let mut command = tokio::process::Command::new(&executable);
        command
            .args(["proxy", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            // Loopback-only sidecar; keep the anonymous usage beacon off.
            .env("HEADROOM_BEACON", "off")
            .env("HEADROOM_TELEMETRY", "off")
            .env("DO_NOT_TRACK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        match command.spawn() {
            Ok(child) => {
                tracing::info!(executable = %executable.display(), port, "headroom proxy started");
                return Ok(child);
            }
            Err(error) => {
                if error.kind() != ErrorKind::NotFound {
                    return Err(error);
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

enum InstallError {
    Missing,
    Failed(String),
}

async fn run_installer(program: &str, args: &[&str]) -> std::result::Result<(), InstallError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            InstallError::Missing
        } else {
            InstallError::Failed(error.to_string())
        }
    })?;
    let output = match tokio::time::timeout(INSTALL_TIMEOUT, child.wait_with_output()).await {
        Ok(output) => output.map_err(|error| InstallError::Failed(error.to_string()))?,
        Err(_) => return Err(InstallError::Failed("installation timed out".into())),
    };
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(InstallError::Failed(
        detail.chars().take(400).collect::<String>(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn json_response(payload: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        )
    }

    /// Reads one HTTP request fully (headers + Content-Length body), then
    /// replies with `response`. Returns the raw request bytes.
    async fn exchange(response: &str) -> (String, tokio::sync::oneshot::Receiver<Vec<u8>>) {
        let response = response.to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 8192];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(head_end) = find_head_end(&buffer) {
                    let head = String::from_utf8_lossy(&buffer[..head_end]).to_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buffer.len() >= head_end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(response.as_bytes()).await.unwrap();
            let _ = sender.send(buffer);
        });
        (format!("http://{address}"), receiver)
    }

    fn find_head_end(buffer: &[u8]) -> Option<usize> {
        buffer.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn route(endpoint: String) -> HeadroomRoute {
        HeadroomRoute {
            endpoint,
            session_id: "conv-1".into(),
        }
    }

    fn chat_body() -> Value {
        serde_json::json!({
            "model": "gpt-5",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true,
            "tools": [{"type": "function", "function": {"name": "t"}}]
        })
    }

    #[tokio::test]
    async fn compress_swaps_the_body_and_merges_headers() {
        let (endpoint, request) = exchange(&json_response(
            "{\"body\":{\"model\":\"gpt-5\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]},\"headers\":{\"anthropic-beta\":\"x\"}}",
        ))
        .await;
        let client = reqwest::Client::new();
        let mut body = chat_body();
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        assert_eq!(body["messages"][0]["content"], "hi");
        assert_eq!(body["model"], "gpt-5");
        assert_eq!(headers.get("anthropic-beta").unwrap(), "x");
        let _ = request.await;
    }

    #[tokio::test]
    async fn gateway_request_carries_session_and_gateway_flags() {
        let (endpoint, request) = exchange(&json_response(
            "{\"body\":{\"model\":\"gpt-5\",\"messages\":[]}}",
        ))
        .await;
        let client = reqwest::Client::new();
        let mut body = chat_body();
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        let raw = request.await.unwrap();
        let head_end = find_head_end(&raw).unwrap();
        let sent: Value = serde_json::from_slice(&raw[head_end + 4..]).unwrap();
        assert_eq!(sent["config"]["session_id"], "conv-1");
        assert_eq!(sent["gateway"]["can_redrive"], false);
        assert_eq!(sent["gateway"]["can_relay_response"], false);
        assert_eq!(sent["model"], "gpt-5");
        assert_eq!(sent["stream"], true);
    }

    #[tokio::test]
    async fn responses_input_is_sent_natively() {
        let (endpoint, request) = exchange(&json_response(
            "{\"body\":{\"model\":\"gpt-5\",\"input\":[{\"a\":1}]}}",
        ))
        .await;
        let client = reqwest::Client::new();
        let mut body = serde_json::json!({
            "model": "gpt-5", "input": [{"type": "message", "role": "user"}], "stream": true
        });
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        assert_eq!(body["input"][0]["a"], 1);
        assert!(body.get("messages").is_none());
        let raw = request.await.unwrap();
        let head_end = find_head_end(&raw).unwrap();
        let sent: Value = serde_json::from_slice(&raw[head_end + 4..]).unwrap();
        assert!(sent.get("messages").is_none());
        assert_eq!(sent["input"][0]["role"], "user");
    }

    #[tokio::test]
    async fn response_without_the_transcript_fails_open() {
        let (endpoint, _request) = exchange(&json_response(
            "{\"body\":{\"model\":\"gpt-5\",\"messages\":[{\"a\":1}]}}",
        ))
        .await;
        let client = reqwest::Client::new();
        let mut body = serde_json::json!({
            "model": "gpt-5", "input": [{"type": "message", "role": "user"}], "stream": true
        });
        let original = body.clone();
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        assert_eq!(body, original);
    }

    #[tokio::test]
    async fn failure_fails_open_with_the_original_body() {
        let (endpoint, _request) =
            exchange("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\n\r\ndown").await;
        let client = reqwest::Client::new();
        let mut body = chat_body();
        let original = body.clone();
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        assert_eq!(body, original);
        assert!(headers.is_empty());
    }

    #[tokio::test]
    async fn unreachable_headroom_fails_open() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = reqwest::Client::new();
        let mut body = chat_body();
        let original = body.clone();
        let mut headers = HeaderMap::new();
        compress_body(&client, &route(endpoint), &mut body, &mut headers).await;
        assert_eq!(body, original);
    }

    #[tokio::test]
    async fn body_without_messages_is_untouched() {
        let client = reqwest::Client::new();
        let mut body = serde_json::json!({"model": "gpt-5", "stream": true});
        let mut headers = HeaderMap::new();
        compress_body(
            &client,
            &route("http://127.0.0.1:1".into()),
            &mut body,
            &mut headers,
        )
        .await;
        assert_eq!(body, serde_json::json!({"model": "gpt-5", "stream": true}));
    }
}
