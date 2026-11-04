//! Updates. Two levels:
//! - Every build looks at the latest published GitHub release and tells the user when it is
//!   newer, with a link to download it.
//! - Builds made with an updater signing key (GitHub secrets TAURI_SIGNING_PRIVATE_KEY and
//!   TAURI_UPDATER_PUBKEY) also download, verify and install the update in place and restart,
//!   when Nusa Studio was installed (the portable files are replaced by hand).

use serde::Serialize;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// owner/repo of the releases; the workflow passes the repository it builds from.
const REPO: &str = match option_env!("NUSA_REPO") {
    Some(r) => r,
    None => "billaheagle/nusa-adt",
};

/// Whether the updater plugin was set up (the build has a public key in its config).
pub struct UpdaterOn(pub bool);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: String,
    url: String,
    /// true: install_update can install it here; false: download it from url
    installable: bool,
}

/// "0.10.1" > "0.9.3"; a "v" prefix and pre-release suffixes are ignored.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

fn releases_page() -> String {
    format!("https://github.com/{REPO}/releases/latest")
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let signed = app.state::<UpdaterOn>().0 && !crate::connections::is_portable();
    if signed {
        if let Ok(updater) = app.updater() {
            match updater.check().await {
                Ok(Some(u)) => {
                    return Ok(Some(UpdateInfo {
                        version: u.version.clone(),
                        current,
                        notes: u.body.clone().unwrap_or_default(),
                        url: releases_page(),
                        installable: true,
                    }))
                }
                Ok(None) => return Ok(None),
                Err(_) => {} // no latest.json yet: fall back to the release list
            }
        }
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("NusaStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if res.status().as_u16() == 404 {
        return Ok(None); // nothing published yet (drafts do not count)
    }
    if !res.status().is_success() {
        return Err(format!("GitHub answered {}", res.status()));
    }
    let j: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let tag = j["tag_name"].as_str().unwrap_or("").to_string();
    if tag.is_empty() || !newer(&tag, &current) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: tag.trim_start_matches('v').to_string(),
        current,
        notes: j["body"].as_str().unwrap_or("").to_string(),
        url: j["html_url"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(releases_page),
        installable: false,
    }))
}

/// Downloads the signed update, checks its signature, installs it and restarts.
#[tauri::command]
#[allow(unreachable_code)]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if !app.state::<UpdaterOn>().0 {
        return Err(
            "This build cannot install updates itself. Download the new version from GitHub."
                .into(),
        );
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Nusa Studio is up to date")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Installing the update failed: {e}"))?;
    app.restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("v0.3.0", "0.2.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0", "0.99.99"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("v0.2.0-beta", "0.2.0"));
        assert!(!newer("0.1.9", "0.2.0"));
    }
}
