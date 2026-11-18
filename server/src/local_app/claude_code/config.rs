//! Edits only Keybridge-owned fields in Claude Code's user settings.
use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use crate::{store::ClaudeCodeSelection, Error, Result};

const BASE_URL: &str = "ANTHROPIC_BASE_URL";
const AUTH_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
const API_KEY: &str = "ANTHROPIC_API_KEY";
const DISCOVERY: &str = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY";
const MANAGED_ENV: [&str; 4] = [BASE_URL, AUTH_TOKEN, API_KEY, DISCOVERY];

pub(super) fn path() -> Result<PathBuf> {
    let home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    Ok(home.join("settings.json"))
}

pub(super) fn load(path: &Path) -> Result<Map<String, Value>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.into()),
    };
    serde_json::from_str::<Map<String, Value>>(&text)
        .map_err(|error| Error::Config(format!("parse Claude Code settings.json: {error}")))
}

pub(super) fn save(path: &Path, settings: &Map<String, Value>) -> Result<()> {
    let text = format!("{}\n", serde_json::to_string_pretty(settings)?);
    if fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.keybridge-tmp");
    fs::write(&temp, text)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn env(settings: &Map<String, Value>) -> Option<&Map<String, Value>> {
    settings.get("env").and_then(Value::as_object)
}

fn env_mut(settings: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    if !settings.contains_key("env") {
        settings.insert("env".into(), Value::Object(Map::new()));
    }
    settings
        .get_mut("env")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| Error::Config("Claude Code settings.json env must be an object".into()))
}

pub(super) fn selection(settings: &Map<String, Value>) -> ClaudeCodeSelection {
    ClaudeCodeSelection {
        model: settings.get("model").cloned(),
        env: MANAGED_ENV
            .iter()
            .map(|key| {
                (
                    (*key).into(),
                    env(settings).and_then(|env| env.get(*key)).cloned(),
                )
            })
            .collect(),
    }
}

pub(super) fn selects_keybridge(settings: &Map<String, Value>) -> bool {
    env(settings)
        .and_then(|env| env.get(BASE_URL))
        .and_then(Value::as_str)
        .is_some_and(|url| url.starts_with("http://127.0.0.1:") && url.ends_with("/byok"))
}

pub(super) fn selected_model(settings: &Map<String, Value>) -> Option<String> {
    settings
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(super) fn matches(
    settings: &Map<String, Value>,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> bool {
    let Some(env) = env(settings) else {
        return false;
    };
    env.get(BASE_URL).and_then(Value::as_str) == Some(base_url)
        && env.get(AUTH_TOKEN).and_then(Value::as_str) == Some(api_key)
        && env.get(DISCOVERY).and_then(Value::as_str) == Some("1")
        && !env.contains_key(API_KEY)
        && selected_model(settings).is_some_and(|model| models.contains(&model))
}

pub(super) fn connect(
    settings: &mut Map<String, Value>,
    base_url: &str,
    api_key: &str,
    models: &[String],
) -> Result<()> {
    let model = selected_model(settings)
        .filter(|model| selects_keybridge(settings) && models.contains(model))
        .or_else(|| models.first().cloned())
        .ok_or_else(|| Error::Config("Claude Code needs at least one configured model".into()))?;
    settings.insert("model".into(), Value::String(model));
    let env = env_mut(settings)?;
    env.insert(BASE_URL.into(), Value::String(base_url.into()));
    env.insert(AUTH_TOKEN.into(), Value::String(api_key.into()));
    env.insert(DISCOVERY.into(), Value::String("1".into()));
    env.remove(API_KEY);
    Ok(())
}

pub(super) fn disconnect(
    settings: &mut Map<String, Value>,
    previous: &ClaudeCodeSelection,
) -> Result<()> {
    if let Some(model) = &previous.model {
        settings.insert("model".into(), model.clone());
    } else {
        settings.remove("model");
    }
    let env = env_mut(settings)?;
    for key in MANAGED_ENV {
        match previous.env.get(key).and_then(Option::as_ref) {
            Some(value) => {
                env.insert(key.into(), value.clone());
            }
            None => {
                env.remove(key);
            }
        }
    }
    if env.is_empty() {
        settings.remove("env");
    }
    Ok(())
}
