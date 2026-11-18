//! Refusal switching through the HTTP routes used by Codex and Claude Code.
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode, Uri},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use cursor_server::{
    api::byok,
    model::{ModelConfigInput, ModelType, RefusalFallback, OPENAI_RESPONSES_ENDPOINT},
    network::NetworkClients,
    protocol::ProtocolRouter,
    provider::{ProviderRegistry, ProviderRuntime},
    store::ExternalApiSettings,
};
use serde_json::{json, Value};
use tower::ServiceExt;

fn model_input(base_url: &str, id: &str, anthropic: bool) -> ModelConfigInput {
    ModelConfigInput {
        sort_order: 0,
        display_name: id.into(),
        group_name: Some("test".into()),
        model_type: if anthropic {
            ModelType::Anthropic
        } else {
            ModelType::OpenAi
        },
        base_url: base_url.into(),
        use_full_url: false,
        api_key: "upstream-test-key".into(),
        tooltip_data: "refusal regression".into(),
        model_id: id.into(),
        reasoning_effort: Some("high".into()),
        openai_endpoint: OPENAI_RESPONSES_ENDPOINT.into(),
        openai_extra_params_enabled: false,
        openai_extra_params: json!({}),
        custom_headers_enabled: false,
        custom_headers: json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: json!({}),
        context_window_tokens: Some(128_000),
        max_completion_tokens: Some(4096),
        anthropic_max_tokens: Some(4096),
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    }
}

struct Harness {
    router: Router,
    received: tokio::sync::mpsc::UnboundedReceiver<Value>,
    active_case: Arc<Mutex<ReplyCase>>,
    server: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}

impl Harness {
    async fn new(anthropic: bool, native: bool, saved_effort: Option<&str>) -> Self {
        let (_directory, store) = fixtures::temp_store().await;
        store
            .set_external_api_settings(ExternalApiSettings {
                enabled: true,
                api_key: "local-test-key".into(),
            })
            .await
            .unwrap();
        let (sent, received) = tokio::sync::mpsc::unbounded_channel();
        let active_case = Arc::new(Mutex::new(ReplyCase::Structured));
        let upstream_case = active_case.clone();
        let upstream = Router::new().route(
            "/{*path}",
            post(move |uri: Uri, Json(body): Json<Value>| {
                let sent = sent.clone();
                let active_case = upstream_case.clone();
                async move {
                    sent.send(body.clone()).unwrap();
                    let case = *active_case.lock().unwrap();
                    upstream_reply(uri.path(), &body, case)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let primary = store
            .create_model(&model_input(&base, "primary", anthropic))
            .await
            .unwrap();
        let mut fallback_input = model_input(&base, "fallback", false);
        fallback_input.reasoning_effort = saved_effort.map(str::to_owned);
        let fallback = store.create_model(&fallback_input).await.unwrap();
        store
            .replace_refusal_fallbacks(&[RefusalFallback {
                model_id: primary.model_hash,
                fallback_model_id: fallback.model_hash,
            }])
            .await
            .unwrap();
        let clients = NetworkClients::new(store.clone());
        let headroom =
            cursor_server::headroom::HeadroomRuntime::new(store.clone(), clients.clone());
        let providers = ProviderRegistry::managed(
            store.clone(),
            ProviderRuntime::managed().unwrap(),
            "0.1.0".into(),
            headroom.clone(),
        )
        .unwrap();
        let protocol = ProtocolRouter::new(
            store.clone(),
            providers.clone(),
            clients.clone(),
            headroom.clone(),
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        let router = byok::router(
            store.clone(),
            providers,
            Arc::new(protocol),
            native.then(|| {
                byok::NativeForwarder::new(
                    store,
                    clients,
                    headroom,
                    Duration::from_secs(5),
                    Duration::from_secs(5),
                )
            }),
        );
        Self {
            router,
            received,
            active_case,
            server,
            _directory,
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
#[ignore = "requires the installed Codex and Claude Code CLIs"]
async fn installed_harnesses_switch_after_the_reported_refusal() {
    for anthropic in [false, true] {
        let mut harness = Harness::new(anthropic, true, Some("high")).await;
        *harness.active_case.lock().unwrap() = ReplyCase::LivePolicy;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/byok", listener.local_addr().unwrap());
        let router = harness.router.clone();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let config_home = directory.path().join("config");
        std::fs::create_dir(&config_home).unwrap();
        let mut command = if anthropic {
            let mut command = tokio::process::Command::new("cmd.exe");
            command.args([
                "/d",
                "/c",
                "claude.cmd",
                "--bare",
                "--print",
                "hello",
                "--model",
                "test/primary",
                "--output-format",
                "json",
                "--no-session-persistence",
            ]);
            command
                .env("CLAUDE_CONFIG_DIR", &config_home)
                .env("ANTHROPIC_BASE_URL", &base)
                .env("ANTHROPIC_API_KEY", "local-test-key")
                .env_remove("ANTHROPIC_AUTH_TOKEN");
            command
        } else {
            std::fs::write(
                config_home.join("config.toml"),
                format!(
                    r#"
model = "test/primary"
model_provider = "keybridge-smoke"
model_reasoning_effort = "medium"
[model_providers.keybridge-smoke]
name = "Keybridge smoke"
base_url = "{base}/v1"
wire_api = "responses"
env_key = "KEYBRIDGE_SMOKE_API_KEY"
"#
                ),
            )
            .unwrap();
            let mut command = tokio::process::Command::new("codex");
            command
                .args([
                    "exec",
                    "--skip-git-repo-check",
                    "--json",
                    "--ephemeral",
                    "hello",
                ])
                .env("CODEX_HOME", &config_home)
                .env("KEYBRIDGE_SMOKE_API_KEY", "local-test-key");
            command
        };
        command.current_dir(directory.path()).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(45), command.output()).await;
        server.abort();
        let output = output.expect("CLI timed out").expect("CLI did not start");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "anthropic={anthropic}: {stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("FALLBACK_OK"),
            "anthropic={anthropic}: {stdout}\n{stderr}"
        );
        assert!(!stdout.contains("PRIMARY_REFUSAL"), "{stdout}");
        let calls: Vec<_> = std::iter::from_fn(|| harness.received.try_recv().ok()).collect();
        assert!(calls.iter().any(|call| call["model"] == "primary"));
        let fallback = calls
            .iter()
            .find(|call| call["model"] == "fallback")
            .unwrap();
        assert_eq!(fallback["reasoning"]["effort"], "high");
        assert_eq!(fallback["max_output_tokens"], 4096);
    }
}

#[tokio::test]
async fn harness_refusals_switch_using_saved_fallback_settings() {
    for saved_effort in [Some("high"), None] {
        for (anthropic, native) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut harness = Harness::new(anthropic, native, saved_effort).await;
            let Harness {
                router,
                received,
                active_case,
                ..
            } = &mut harness;
            let path = if anthropic {
                "/byok/v1/messages"
            } else {
                "/byok/v1/responses"
            };
            for streaming in [false, true] {
                for effort in ["medium", "max"] {
                    for case in ReplyCase::ALL {
                        *active_case.lock().unwrap() = case;
                        let mut body = json!({"model":"test/primary","stream":streaming,"reasoning":{"effort":effort},"service_tier":"priority","max_output_tokens":123,"input":"hello","native_extension":{"keep":true},"instructions":"Keep these instructions."});
                        if anthropic {
                            body["messages"] = json!([{"role":"user","content":"hello"}]);
                            body["max_tokens"] = json!(123);
                            body["output_config"] = json!({"effort":effort});
                            body["system"] = json!("Keep these instructions.");
                            for field in ["input", "instructions", "reasoning", "max_output_tokens"]
                            {
                                body.as_object_mut().unwrap().remove(field);
                            }
                        }
                        let response = router
                            .clone()
                            .oneshot(
                                Request::post(path)
                                    .header(header::AUTHORIZATION, "Bearer local-test-key")
                                    .header(header::CONTENT_TYPE, "application/json")
                                    .body(Body::from(body.to_string()))
                                    .unwrap(),
                            )
                            .await
                            .unwrap();
                        let status = response.status();
                        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
                        let answer = String::from_utf8(bytes.to_vec()).unwrap();
                        let context = format!(
                            "{path} native={native} stream={streaming} effort={effort} case={case:?}"
                        );
                        let first = received.try_recv().unwrap();
                        assert_eq!(first["model"], "primary", "{context}");
                        assert_eq!(
                            first[if anthropic {
                                "output_config"
                            } else {
                                "reasoning"
                            }]["effort"],
                            effort,
                            "{context}"
                        );
                        if native {
                            assert_eq!(first["native_extension"]["keep"], true);
                        }
                        if case == ReplyCase::Error {
                            if native {
                                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                            } else if streaming {
                                assert!(answer.contains("rate limit"), "{context}: {answer}");
                            } else {
                                assert!(!status.is_success(), "{context}: {answer}");
                            }
                        } else {
                            assert_eq!(status, StatusCode::OK, "{context}: {answer}");
                            if case.switches() {
                                if case != ReplyCase::FallbackRefuses {
                                    assert!(answer.contains("FALLBACK_OK"), "{context}: {answer}");
                                }
                                assert!(!answer.contains("PRIMARY_REFUSAL"), "{context}: {answer}");
                                assert!(
                                    !answer.contains("I stopped before launching"),
                                    "{context}: {answer}"
                                );
                                assert!(
                                    !answer.contains("matched trace excerpts"),
                                    "{context}: {answer}"
                                );
                                assert!(
                                    !answer.contains("earliest confirmed black image"),
                                    "{context}: {answer}"
                                );
                                let second = received.try_recv().unwrap();
                                assert_eq!(second["model"], "fallback", "{context}");
                                assert_eq!(
                                    second["reasoning"]["effort"],
                                    json!(saved_effort),
                                    "{context}"
                                );
                                assert_eq!(second["max_output_tokens"], 4096, "{context}");
                                assert!(second.get("service_tier").is_none(), "{context}");
                                assert_eq!(
                                    second["instructions"], "Keep these instructions.",
                                    "{context}"
                                );
                            } else {
                                assert!(!answer.contains("FALLBACK_OK"), "{context}: {answer}");
                                assert!(
                                    answer.contains(if case == ReplyCase::Tool {
                                        "lookup"
                                    } else {
                                        "Example"
                                    }),
                                    "{context}: {answer}"
                                );
                            }
                        }
                        assert!(received.try_recv().is_err(), "{context}: unexpected retry");
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ReplyCase {
    Structured,
    Wording,
    ReportedDidNotStart,
    ReportedDidNotRun,
    ReportedStopped,
    ReasonBeforeStopping,
    LivePolicy,
    Quoted,
    Tool,
    Error,
    FallbackRefuses,
}

impl ReplyCase {
    const ALL: [Self; 11] = [
        Self::Structured,
        Self::Wording,
        Self::ReportedDidNotStart,
        Self::ReportedDidNotRun,
        Self::ReportedStopped,
        Self::ReasonBeforeStopping,
        Self::LivePolicy,
        Self::Quoted,
        Self::Tool,
        Self::Error,
        Self::FallbackRefuses,
    ];
    fn switches(self) -> bool {
        matches!(
            self,
            Self::Structured
                | Self::Wording
                | Self::ReportedDidNotStart
                | Self::ReportedDidNotRun
                | Self::ReportedStopped
                | Self::ReasonBeforeStopping
                | Self::LivePolicy
                | Self::FallbackRefuses
        )
    }
}

fn upstream_reply(path: &str, body: &Value, case: ReplyCase) -> axum::response::Response {
    let primary = body["model"] == "primary";
    if primary && case == ReplyCase::Error {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":{"message":"rate limit"}})),
        )
            .into_response();
    }
    let explicit = (primary && matches!(case, ReplyCase::Structured | ReplyCase::FallbackRefuses))
        || (!primary && case == ReplyCase::FallbackRefuses);
    let text = if !primary {
        "FALLBACK_OK".to_owned()
    } else {
        match case {
        ReplyCase::Wording => format!("{}\n\nPRIMARY_REFUSAL: I cannot help with this request.", "Some background. ".repeat(100)),
        ReplyCase::ReportedDidNotStart => include_str!("fixtures/refusals/did-not-start-policy.md").into(),
        ReplyCase::ReportedDidNotRun => include_str!("fixtures/refusals/did-not-run-policy.md").into(),
        ReplyCase::ReportedStopped => include_str!("fixtures/refusals/stopped-before-launching-policy.md").into(),
        ReplyCase::ReasonBeforeStopping => include_str!("fixtures/refusals/reason-before-stopping-policy.md").into(),
        ReplyCase::LivePolicy => serde_json::from_str::<Value>(include_str!("fixtures/refusals/live-policy-refusals.json")).unwrap()[0]["text"].as_str().unwrap().to_owned(),
        ReplyCase::Quoted => "Example:\n```text\nI cannot help with this request.\n```\n\n> I cannot assist with that.\n\nHere is the explanation.".into(),
        ReplyCase::Tool => "I cannot help with that example, so I will inspect the file first.".into(),
        _ => "PRIMARY_REFUSAL".into(),
    }
    };
    let tool = primary && case == ReplyCase::Tool;
    let streaming = body["stream"] == true;
    let (complete, events) = if path.ends_with("messages") {
        let content = if tool {
            json!([{"type":"tool_use","id":"call_lookup","name":"lookup","input":{"q":"hello"}}])
        } else {
            json!([{"type":"text","text":text}])
        };
        let reason = if explicit {
            "refusal"
        } else if tool {
            "tool_use"
        } else {
            "end_turn"
        };
        let complete = json!({"id":"msg_test","type":"message","role":"assistant","model":"primary","content":content,"stop_reason":reason,"usage":{"input_tokens":1,"output_tokens":1}});
        let mut events = vec![
            json!({"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
        ];
        if tool {
            events.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_lookup","name":"lookup","input":{}}}));
            events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"q\":\"hello\"}"}}));
        } else {
            events.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}));
            // Split inside refusal wording to exercise cross-chunk inspection.
            for chunk in text.chars().collect::<Vec<_>>().chunks(23) {
                events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":chunk.iter().collect::<String>()}}));
            }
        }
        events.push(json!({"type":"content_block_stop","index":0}));
        events.push(json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":1}}));
        events.push(json!({"type":"message_stop"}));
        (complete, events)
    } else {
        let item = if tool {
            json!({"type":"function_call","id":"fc_lookup","call_id":"call_lookup","name":"lookup","arguments":"{\"q\":\"hello\"}"})
        } else {
            json!({"type":"message","id":"msg_test","role":"assistant","content":if explicit { json!([{"type":"refusal","refusal":text}]) } else { json!([{"type":"output_text","text":text}]) }})
        };
        let complete = json!({"id":"resp_test","object":"response","status":"completed","output":[item],"usage":{"input_tokens":1,"output_tokens":1}});
        let mut events = Vec::new();
        if !tool && !explicit {
            for chunk in text.chars().collect::<Vec<_>>().chunks(23) {
                events.push(json!({"type":"response.output_text.delta","delta":chunk.iter().collect::<String>()}));
            }
        }
        events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
        events.push(json!({"type":"response.completed","response":complete}));
        (complete, events)
    };
    if !streaming {
        return Json(complete).into_response();
    }
    let mut encoded = String::new();
    for event in events {
        encoded.push_str(&format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        ));
    }
    // Native forwarding receives fragmented SSE, including split JSON fields.
    let chunks = encoded
        .into_bytes()
        .chunks(17)
        .map(|chunk| Ok::<_, std::convert::Infallible>(bytes::Bytes::copy_from_slice(chunk)))
        .collect::<Vec<_>>();
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response()
}
