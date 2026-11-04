// Nusa Studio desktop shell. The UI is web code; this side owns the network:
// sessions, CSRF, cookies, stateful locks, auth and the connection list.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connections;
mod oauth;
mod rfc;
mod session;
mod update;

use connections::Connection;
use session::{AdtReq, AdtResp, Session};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[tauri::command]
async fn list_connections(app: tauri::AppHandle) -> Result<Vec<Connection>, String> {
    connections::list(&app)
}

#[tauri::command]
async fn save_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    conn: Connection,
    secret: Option<String>,
) -> Result<(), String> {
    // Only a change in how the system is reached needs a new session. Saving favorites
    // must not drop it: with browser logon that would open the browser again.
    let old = connections::list(&app)?
        .into_iter()
        .find(|c| c.id == conn.id);
    if secret.is_some() || old.map(|o| o.session_differs(&conn)).unwrap_or(true) {
        state.sessions.lock().await.remove(&conn.id);
    }
    connections::save(&app, conn, secret)
}

#[tauri::command]
fn cancel_logon() {
    oauth::cancel_logon();
}

#[tauri::command]
fn reopen_logon(app: tauri::AppHandle) -> Result<(), String> {
    oauth::reopen_logon(&app)
}

#[tauri::command]
async fn delete_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.sessions.lock().await.remove(&id);
    connections::delete(&app, &id)
}

/// Drops the HTTP session so the next request logs in again (used by "Log in again").
#[tauri::command]
async fn reset_session(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.sessions.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
async fn adt_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    conn: String,
    req: AdtReq,
) -> Result<AdtResp, String> {
    let sess = {
        let mut map = state.sessions.lock().await;
        match map.get(&conn) {
            Some(s) => s.clone(),
            None => {
                let c = connections::list(&app)?
                    .into_iter()
                    .find(|c| c.id == conn)
                    .ok_or_else(|| format!("Unknown system {conn}"))?;
                let s = Session::new(c, connections::secret(&conn))?;
                map.insert(conn.clone(), s.clone());
                s
            }
        }
    };
    sess.request(req, &app).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // In-app updates need the public key the release workflow writes into the config
            // when the signing key is set up; without it the plugin would refuse to start.
            let key = app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|u| u.get("pubkey"))
                .and_then(|k| k.as_str())
                .map(|k| !k.trim().is_empty())
                .unwrap_or(false);
            if key {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            app.manage(update::UpdaterOn(key));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cancel_logon,
            reopen_logon,
            list_connections,
            save_connection,
            delete_connection,
            reset_session,
            adt_request,
            update::check_update,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nusa Studio");
}
