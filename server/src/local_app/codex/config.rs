//! Edits the Codex `config.toml`, touching only the keys Keybridge manages.
use std::{
    fs,
    path::{Path, PathBuf},
};

use toml_edit::{value, DocumentMut, Item, Table};

use crate::{store::CodexSelection, Error, Result};

/// The `[model_providers.<id>]` entry Keybridge owns in the Codex config.
pub(super) const PROVIDER_ID: &str = "keybridge";

const MODEL: &str = "model";
const MODEL_PROVIDER: &str = "model_provider";
const MODEL_CATALOG: &str = "model_catalog_json";
const MODEL_PROVIDERS: &str = "model_providers";

/// Everything Codex needs to send its model requests to Keybridge.
pub(super) struct Connection<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub catalog_path: &'a str,
    /// Slugs in the catalog; the first one is selected when Codex has none of them selected.
    pub models: &'a [String],
}

/// The Codex home directory: `CODEX_HOME`, or `.codex` in the user's home.
pub(super) fn home() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))
}

pub(super) fn load(path: &Path) -> Result<DocumentMut> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    text.parse()
        .map_err(|error| Error::Config(format!("parse Codex config.toml: {error}")))
}

/// Writes the document only when it differs from the file, so an unchanged
/// configuration never touches the user's file.
pub(super) fn save(path: &Path, document: &DocumentMut) -> Result<()> {
    let text = document.to_string();
    if fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("toml.keybridge-tmp");
    fs::write(&temp, text)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn string(document: &DocumentMut, key: &str) -> Option<String> {
    document.get(key).and_then(Item::as_str).map(str::to_owned)
}

fn set(document: &mut DocumentMut, key: &str, text: Option<&str>) {
    let Some(text) = text else {
        document.remove(key);
        return;
    };
    match document.get_mut(key).and_then(Item::as_value_mut) {
        // Replacing the value in place keeps the comments written around the key.
        Some(existing) => {
            if existing.as_str() != Some(text) {
                let decor = existing.decor().clone();
                *existing = text.into();
                *existing.decor_mut() = decor;
            }
        }
        None => {
            document.insert(key, value(text));
        }
    }
}

pub(super) fn selection(document: &DocumentMut) -> CodexSelection {
    CodexSelection {
        model: string(document, MODEL),
        model_provider: string(document, MODEL_PROVIDER),
        model_catalog_json: string(document, MODEL_CATALOG),
    }
}

/// Whether Codex currently sends its requests to Keybridge.
pub(super) fn selects_keybridge(document: &DocumentMut) -> bool {
    string(document, MODEL_PROVIDER).as_deref() == Some(PROVIDER_ID)
}

pub(super) fn selected_model(document: &DocumentMut) -> Option<String> {
    string(document, MODEL)
}

fn provider_table(connection: &Connection<'_>) -> Table {
    let mut provider = Table::new();
    provider.insert("name", value("Keybridge"));
    provider.insert("base_url", value(connection.base_url));
    provider.insert("wire_api", value("responses"));
    provider.insert("experimental_bearer_token", value(connection.api_key));
    provider
}

fn provider_matches(document: &DocumentMut, connection: &Connection<'_>) -> bool {
    let Some(provider) = document
        .get(MODEL_PROVIDERS)
        .and_then(Item::as_table_like)
        .and_then(|providers| providers.get(PROVIDER_ID))
        .and_then(Item::as_table_like)
    else {
        return false;
    };
    let field = |key: &str| provider.get(key).and_then(Item::as_str);
    field("base_url") == Some(connection.base_url)
        && field("wire_api") == Some("responses")
        && field("experimental_bearer_token") == Some(connection.api_key)
}

/// Whether the document already routes Codex to this exact connection.
pub(super) fn matches(document: &DocumentMut, connection: &Connection<'_>) -> bool {
    selects_keybridge(document)
        && string(document, MODEL_CATALOG).as_deref() == Some(connection.catalog_path)
        && selected_model(document).is_some_and(|model| connection.models.contains(&model))
        && provider_matches(document, connection)
}

pub(super) fn connect(document: &mut DocumentMut, connection: &Connection<'_>) -> Result<()> {
    // A model the user picked inside Codex stays selected while it is still offered.
    let model = selected_model(document)
        .filter(|model| selects_keybridge(document) && connection.models.contains(model))
        .or_else(|| connection.models.first().cloned())
        .ok_or_else(|| Error::Config("Codex needs at least one configured model".into()))?;
    set(document, MODEL, Some(&model));
    set(document, MODEL_PROVIDER, Some(PROVIDER_ID));
    set(document, MODEL_CATALOG, Some(connection.catalog_path));
    if !provider_matches(document, connection) {
        if document.get(MODEL_PROVIDERS).is_none() {
            let mut providers = Table::new();
            providers.set_implicit(true);
            document.insert(MODEL_PROVIDERS, Item::Table(providers));
        }
        document[MODEL_PROVIDERS]
            .as_table_like_mut()
            .ok_or_else(|| Error::Config("model_providers in Codex config is not a table".into()))?
            .insert(PROVIDER_ID, Item::Table(provider_table(connection)));
    }
    Ok(())
}

/// Removes Keybridge and puts back the selection the user had before it was connected.
pub(super) fn disconnect(
    document: &mut DocumentMut,
    previous: &CodexSelection,
    catalog_path: &str,
) {
    if selects_keybridge(document) {
        set(document, MODEL, previous.model.as_deref());
        set(document, MODEL_PROVIDER, previous.model_provider.as_deref());
    }
    if string(document, MODEL_CATALOG).as_deref() == Some(catalog_path) {
        set(
            document,
            MODEL_CATALOG,
            previous.model_catalog_json.as_deref(),
        );
    }
    let emptied = document
        .get_mut(MODEL_PROVIDERS)
        .and_then(Item::as_table_like_mut)
        .is_some_and(|providers| {
            providers.remove(PROVIDER_ID);
            providers.is_empty()
        });
    if emptied {
        document.remove(MODEL_PROVIDERS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = r"C:\Users\me\.cursor-byok-v3\codex\models.json";

    fn connection<'a>(models: &'a [String], base_url: &'a str) -> Connection<'a> {
        Connection {
            base_url,
            api_key: "secret",
            catalog_path: CATALOG,
            models,
        }
    }

    fn models() -> Vec<String> {
        vec!["work/model-a".into(), "work/model-b".into()]
    }

    #[test]
    fn connecting_and_disconnecting_returns_the_user_config_unchanged() {
        let original = r#"# my Codex setup
model = "gpt-5.5"            # daily driver
model_reasoning_effort = "high"

[model_providers.local]
name = "Local"
base_url = "http://localhost:11434/v1"

[mcp_servers.docs]
command = "docs-mcp"
"#;
        let mut document: DocumentMut = original.parse().unwrap();
        let previous = selection(&document);
        let models = models();
        let connection = connection(&models, "http://127.0.0.1:3000/byok/v1");
        assert!(!matches(&document, &connection));
        connect(&mut document, &connection).unwrap();
        assert!(matches(&document, &connection));
        assert_eq!(selected_model(&document).as_deref(), Some("work/model-a"));
        let connected = document.to_string();
        assert!(
            connected.contains("[model_providers.keybridge]"),
            "{connected}"
        );
        assert!(connected.contains("[model_providers.local]"), "{connected}");
        assert!(connected.contains("# my Codex setup"), "{connected}");

        disconnect(&mut document, &previous, CATALOG);
        assert_eq!(document.to_string(), original);
        assert_eq!(selection(&document), previous);
        let restored = document.to_string();
        assert!(!restored.contains("keybridge"), "{restored}");
        assert!(restored.contains("[model_providers.local]"), "{restored}");
        assert!(restored.contains("[mcp_servers.docs]"), "{restored}");
        assert!(
            restored.contains(r#"model_reasoning_effort = "high""#),
            "{restored}"
        );
    }

    #[test]
    fn an_empty_config_is_left_empty_after_disconnecting() {
        let mut document = DocumentMut::new();
        let previous = selection(&document);
        let models = models();
        connect(
            &mut document,
            &connection(&models, "http://127.0.0.1:3000/byok/v1"),
        )
        .unwrap();
        disconnect(&mut document, &previous, CATALOG);
        assert_eq!(document.to_string().trim(), "");
    }

    #[test]
    fn reconnecting_keeps_the_model_picked_in_codex_and_follows_a_new_port() {
        let mut document = DocumentMut::new();
        let models = models();
        connect(
            &mut document,
            &connection(&models, "http://127.0.0.1:3000/byok/v1"),
        )
        .unwrap();
        document.insert(MODEL, value("work/model-b"));
        let moved = connection(&models, "http://127.0.0.1:4000/byok/v1");
        assert!(!matches(&document, &moved));
        connect(&mut document, &moved).unwrap();
        assert!(matches(&document, &moved));
        assert_eq!(selected_model(&document).as_deref(), Some("work/model-b"));

        // A model that is no longer offered falls back to the first one.
        let remaining = vec!["work/model-a".to_string()];
        let shrunk = connection(&remaining, "http://127.0.0.1:4000/byok/v1");
        assert!(!matches(&document, &shrunk));
        connect(&mut document, &shrunk).unwrap();
        assert_eq!(selected_model(&document).as_deref(), Some("work/model-a"));
    }

    #[test]
    fn disconnecting_leaves_a_selection_the_user_changed_by_hand() {
        let mut document = DocumentMut::new();
        let models = models();
        connect(
            &mut document,
            &connection(&models, "http://127.0.0.1:3000/byok/v1"),
        )
        .unwrap();
        document.insert(MODEL_PROVIDER, value("openai"));
        document.insert(MODEL, value("gpt-5.5"));
        disconnect(&mut document, &CodexSelection::default(), CATALOG);
        assert_eq!(
            selection(&document),
            CodexSelection {
                model: Some("gpt-5.5".into()),
                model_provider: Some("openai".into()),
                model_catalog_json: None,
            }
        );
    }
}
