//! System list in the app config folder; passwords and service keys in the OS keychain.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const KEYRING_SERVICE: &str = "nusa-adt";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    S4,
    S4cloud,
    Btp,
    Runner,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    Basic,
    Oauth,
    Sso,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: Kind,
    pub sid: String,
    pub client: String,
    pub user: String,
    pub url: String,
    pub language: String,
    pub auth: Auth,
    pub abap_version: String,
    #[serde(default)]
    pub favorite_packages: Vec<String>,
    pub transports: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_self_signed: Option<bool>,
}

/// Portable mode: when the executable's name contains "portable" (or a `portable.txt`
/// file sits next to it), settings live in `nusa-adt-data` beside the executable
/// instead of the user profile, so the app can run from a USB stick or Downloads.
fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let by_name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_lowercase().contains("portable"))
        .unwrap_or(false);
    if by_name || dir.join("portable.txt").exists() {
        Some(dir.join("nusa-adt-data"))
    } else {
        None
    }
}

fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = match portable_dir() {
        Some(d) => d,
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<Connection>, String> {
    let f = file(app)?;
    if !f.exists() {
        // First start: offer the local runner so the IDE is usable without SAP access.
        return Ok(vec![Connection {
            id: "local".into(),
            kind: Kind::Runner,
            sid: "LOCAL".into(),
            client: "000".into(),
            user: "NUSA".into(),
            url: "http://localhost:7777".into(),
            language: "EN".into(),
            auth: Auth::None,
            abap_version: "runner".into(),
            favorite_packages: vec!["$TMP".into()],
            transports: false,
            label: Some("ABAP runner on this laptop".into()),
            allow_self_signed: None,
        }]);
    }
    let text = fs::read_to_string(&f).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("connections.json is invalid: {e}"))
}

pub fn save(
    app: &tauri::AppHandle,
    conn: Connection,
    secret: Option<String>,
) -> Result<(), String> {
    let mut all = list(app)?;
    all.retain(|c| c.id != conn.id);
    if let Some(s) = secret {
        keyring::Entry::new(KEYRING_SERVICE, &conn.id)
            .and_then(|e| e.set_password(&s))
            .map_err(|e| format!("Could not store the secret in the keychain: {e}"))?;
    }
    all.push(conn);
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut all = list(app)?;
    all.retain(|c| c.id != id);
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, id) {
        let _ = e.delete_credential();
    }
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    fs::write(file(app)?, text).map_err(|e| e.to_string())
}

pub fn secret(id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .ok()?
        .get_password()
        .ok()
}
