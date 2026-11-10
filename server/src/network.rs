//! Owns reusable outbound HTTP clients configured from persisted proxy settings.

use std::{sync::Arc, time::Duration};

use tokio::sync::RwLock;

use crate::{
    store::{ProxySettingsSecret, Store},
    Error, Result,
};

const LOCAL_NO_PROXY: &str = "localhost,127.0.0.0/8,::1";

#[derive(Clone)]
pub struct NetworkClients {
    store: Store,
    cache: Arc<RwLock<ClientCache>>,
}

#[derive(Default)]
struct ClientCache {
    default: Option<reqwest::Client>,
    cursor: Option<reqwest::Client>,
    protocol: Option<(Duration, reqwest::Client)>,
}

impl NetworkClients {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            cache: Arc::new(RwLock::new(ClientCache::default())),
        }
    }

    pub async fn default_client(&self) -> Result<reqwest::Client> {
        if let Some(client) = self.cache.read().await.default.clone() {
            return Ok(client);
        }
        let mut cache = self.cache.write().await;
        if let Some(client) = cache.default.clone() {
            return Ok(client);
        }
        let client = client_builder(&self.store).await?.build()?;
        cache.default = Some(client.clone());
        Ok(client)
    }

    pub async fn cursor_client(&self) -> Result<reqwest::Client> {
        if let Some(client) = self.cache.read().await.cursor.clone() {
            return Ok(client);
        }
        let mut cache = self.cache.write().await;
        if let Some(client) = cache.cursor.clone() {
            return Ok(client);
        }
        let client = client_builder(&self.store)
            .await?
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        cache.cursor = Some(client.clone());
        Ok(client)
    }

    pub async fn protocol_client(&self, timeout: Duration) -> Result<reqwest::Client> {
        if let Some((_, client)) = self
            .cache
            .read()
            .await
            .protocol
            .as_ref()
            .filter(|(cached_timeout, _)| *cached_timeout == timeout)
        {
            return Ok(client.clone());
        }
        let mut cache = self.cache.write().await;
        if let Some((_, client)) = cache
            .protocol
            .as_ref()
            .filter(|(cached_timeout, _)| *cached_timeout == timeout)
        {
            return Ok(client.clone());
        }
        let client = client_builder(&self.store)
            .await?
            .timeout(timeout)
            .build()?;
        cache.protocol = Some((timeout, client.clone()));
        Ok(client)
    }

    pub async fn invalidate(&self) {
        *self.cache.write().await = ClientCache::default();
    }
}

/// TLS backend per platform. Windows and macOS keep native-tls for provider
/// gateways that only offer legacy TLS 1.2 cipher suites unsupported by
/// rustls. Linux uses rustls because wreq's BoringSSL is linked under the
/// same `ssl`/`crypto` names and collides with OpenSSL at link time.
pub fn tls_builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "linux")]
    {
        reqwest::Client::builder().use_rustls_tls()
    }
    #[cfg(not(target_os = "linux"))]
    {
        reqwest::Client::builder().use_native_tls()
    }
}

pub fn blocking_tls_builder() -> reqwest::blocking::ClientBuilder {
    #[cfg(target_os = "linux")]
    {
        reqwest::blocking::Client::builder().use_rustls_tls()
    }
    #[cfg(not(target_os = "linux"))]
    {
        reqwest::blocking::Client::builder().use_native_tls()
    }
}

pub async fn client_builder(store: &Store) -> Result<reqwest::ClientBuilder> {
    let settings = store.proxy_settings_secret().await?;
    let mut builder = tls_builder();
    if settings.mode.is_custom() {
        builder = builder.proxy(custom_proxy(&settings)?);
    }
    Ok(builder)
}

pub async fn client(store: &Store) -> Result<reqwest::Client> {
    Ok(client_builder(store).await?.build()?)
}

/// BoringSSL/Chrome-family cipher list, in the order the OpenCode CLI (Bun)
/// sends it. Endpoints behind JA4 cipher-hash gates refuse the platform TLS
/// stack; the list's hash is compared, so this must stay verbatim.
const EMULATED_CIPHER_LIST: &str = "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA";

/// wreq (BoringSSL) client for provider hosts that gate on the TLS ClientHello.
/// Honors the same persisted proxy settings as `client_builder`.
pub async fn emulated_client_builder(store: &Store) -> Result<wreq::ClientBuilder> {
    let settings = store.proxy_settings_secret().await?;
    let tls_options = wreq::tls::TlsOptions::builder()
        .cipher_list(EMULATED_CIPHER_LIST)
        .build();
    let mut builder = wreq::Client::builder().tls_options(tls_options);
    if settings.mode.is_custom() {
        builder = builder.proxy(emulated_custom_proxy(&settings)?);
    }
    Ok(builder)
}

/// Egress diversity for quota-gated free lanes (upstream meters per source IP).
/// Optional `opencode-egress.json` in the data dir:
///   { "proxies": ["socks5h://host:port", "http://host:port", ...],
///     "source_ipv6": "2001:db8:1234:5678::/64" }
/// Each request picks the next proxy round-robin and/or binds to a random
/// address inside the routed IPv6 prefix. Both keys are optional; an absent
/// or malformed file falls back to the plain emulated client.
#[derive(Default, serde::Deserialize)]
struct EgressConfig {
    #[serde(default)]
    proxies: Vec<String>,
    #[serde(default)]
    source_ipv6: Option<String>,
}

static EGRESS_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn egress_config() -> Option<EgressConfig> {
    let path = crate::config::managed_data_dir()
        .ok()?
        .join("opencode-egress.json");
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn random_ipv6_in_prefix(prefix: &str) -> Option<std::net::Ipv6Addr> {
    let (network, bits) = prefix.split_once('/')?;
    let base: u128 = network.parse::<std::net::Ipv6Addr>().ok()?.into();
    let bits: u32 = bits.parse().ok()?;
    if bits > 128 {
        return None;
    }
    let host_bits = 128 - bits;
    let host_mask = if host_bits >= 128 {
        u128::MAX
    } else {
        (1u128 << host_bits) - 1
    };
    let network_mask = if host_bits >= 128 {
        0
    } else {
        u128::MAX << host_bits
    };
    let host = u128::from_be_bytes(*uuid::Uuid::new_v4().as_bytes()) & host_mask;
    Some(std::net::Ipv6Addr::from((base & network_mask) | host))
}

/// Emulated client for one request: TLS fingerprint plus a rotated egress
/// when `opencode-egress.json` is configured, honoring proxy settings
/// otherwise. Callers get a fully built client.
pub async fn emulated_client(store: &Store) -> Result<wreq::Client> {
    let config = egress_config();
    let mut builder = if config
        .as_ref()
        .is_some_and(|config| !config.proxies.is_empty())
    {
        // The egress pool owns the path; the single-proxy setting would
        // pin every request to one egress anyway.
        wreq::Client::builder().tls_options(
            wreq::tls::TlsOptions::builder()
                .cipher_list(EMULATED_CIPHER_LIST)
                .build(),
        )
    } else {
        emulated_client_builder(store).await?
    };
    builder = builder
        .redirect(wreq::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30));
    if let Some(config) = config {
        let index = EGRESS_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if !config.proxies.is_empty() {
            let uri = &config.proxies[index % config.proxies.len()];
            let proxy = wreq::Proxy::all(uri)
                .map_err(|error| Error::Config(format!("invalid egress proxy '{uri}': {error}")))?;
            builder = builder.proxy(proxy);
        }
        if let Some(prefix) = &config.source_ipv6 {
            if let Some(address) = random_ipv6_in_prefix(prefix) {
                builder = builder.local_address(std::net::IpAddr::V6(address));
            }
        }
    }
    builder
        .build()
        .map_err(|error| Error::Provider(format!("emulated HTTP client init failed: {error}")))
}

fn emulated_custom_proxy(settings: &ProxySettingsSecret) -> Result<wreq::Proxy> {
    let mut proxy = wreq::Proxy::all(&settings.address)
        .map_err(|error| Error::Config(format!("invalid proxy address: {error}")))?
        .no_proxy(wreq::NoProxy::from_string(LOCAL_NO_PROXY));
    if settings.auth_enabled {
        proxy = proxy.basic_auth(&settings.username, &settings.password);
    }
    Ok(proxy)
}

pub async fn blocking_client_builder(store: &Store) -> Result<reqwest::blocking::ClientBuilder> {
    let settings = store.proxy_settings_secret().await?;
    let mut builder = blocking_tls_builder();
    if settings.mode.is_custom() {
        builder = builder.proxy(custom_proxy(&settings)?);
    }
    Ok(builder)
}

fn custom_proxy(settings: &ProxySettingsSecret) -> Result<reqwest::Proxy> {
    let mut proxy = reqwest::Proxy::all(&settings.address)?
        .no_proxy(reqwest::NoProxy::from_string(LOCAL_NO_PROXY));
    if settings.auth_enabled {
        proxy = proxy.basic_auth(&settings.username, &settings.password);
    }
    Ok(proxy)
}

pub fn reject_self_proxy(address: &str, local_proxy_port: u16) -> Result<()> {
    if local_proxy_port == 0 {
        return Ok(());
    }
    let url = url::Url::parse(address)
        .map_err(|error| Error::Config(format!("invalid proxy address: {error}")))?;
    if url.port_or_known_default() == Some(local_proxy_port) && url_host_is_loopback(&url) {
        return Err(Error::Config(
            "proxy address cannot point to the Cursor BYOK local proxy".into(),
        ));
    }
    Ok(())
}

fn url_host_is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => {
            host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::store::ProxyMode;

    fn custom_settings(address: String) -> ProxySettingsSecret {
        ProxySettingsSecret {
            mode: ProxyMode::Custom,
            address,
            auth_enabled: false,
            username: String::new(),
            password: String::new(),
        }
    }

    #[test]
    fn rejects_only_own_loopback_proxy_port() {
        for address in [
            "http://localhost:15721",
            "http://localhost.:15721",
            "http://127.0.0.2:15721",
            "http://[::1]:15721",
        ] {
            assert!(reject_self_proxy(address, 15721).is_err(), "{address}");
        }
        assert!(reject_self_proxy("http://127.0.0.1:7890", 15721).is_ok());
        assert!(reject_self_proxy("http://192.168.1.2:15721", 15721).is_ok());
        assert!(reject_self_proxy("http://127.0.0.1:15721", 0).is_ok());
    }

    #[tokio::test]
    async fn custom_proxy_bypasses_loopback_destinations() {
        let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target = tokio::spawn(async move {
            let (mut socket, _) = target_listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        });
        let settings = custom_settings(format!("http://{proxy_address}"));
        let client = reqwest::Client::builder()
            .proxy(custom_proxy(&settings).unwrap())
            .build()
            .unwrap();

        let body = client
            .get(format!("http://{target_address}"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();

        assert_eq!(body, "ok");
        target.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), proxy_listener.accept())
                .await
                .is_err(),
            "loopback destination unexpectedly reached the configured proxy"
        );
    }
}
