//! Browser login for SAP BTP ABAP Environment using the instance's service key.
//! Authorization-code flow: open the UAA login page, catch the redirect on localhost,
//! exchange the code for a token. The service key JSON is stored in the keychain.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Deserialize)]
struct ServiceKey {
    uaa: Uaa,
}
#[derive(Deserialize)]
struct Uaa {
    url: String,
    clientid: String,
    clientsecret: String,
}
#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

pub struct Token {
    pub access_token: String,
    pub refresh_token: Option<String>,
    expires: Instant,
}
impl Token {
    pub fn expired(&self) -> bool {
        Instant::now() + Duration::from_secs(30) >= self.expires
    }
}

fn parse_key(key: &str) -> Result<Uaa, String> {
    serde_json::from_str::<ServiceKey>(key)
        .map(|k| k.uaa)
        .map_err(|e| format!("The saved service key is not valid JSON with a uaa section: {e}"))
}

async fn token(uaa: &Uaa, form: &[(&str, &str)]) -> Result<Token, String> {
    let res = reqwest::Client::new()
        .post(format!("{}/oauth/token", uaa.url.trim_end_matches('/')))
        .basic_auth(&uaa.clientid, Some(&uaa.clientsecret))
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Token request failed: HTTP {}", res.status()));
    }
    let t: TokenResp = res.json().await.map_err(|e| e.to_string())?;
    Ok(Token {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires: Instant::now() + Duration::from_secs(t.expires_in.unwrap_or(3600)),
    })
}

pub async fn refresh(key: &str, refresh_token: &str) -> Result<Token, String> {
    let uaa = parse_key(key)?;
    token(
        &uaa,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ],
    )
    .await
}

pub async fn login(app: &tauri::AppHandle, key: &str) -> Result<Token, String> {
    let uaa = parse_key(key)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://localhost:{port}/adt/redirect");
    let auth_url = format!(
        "{}/oauth/authorize?response_type=code&client_id={}&redirect_uri={}",
        uaa.url.trim_end_matches('/'),
        urlencode(&uaa.clientid),
        urlencode(&redirect)
    );
    app.opener()
        .open_url(auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_param(&listener, "code"))
        .await
        .map_err(|_| "Login timed out after 5 minutes".to_string())??;

    token(
        &uaa,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
        ],
    )
    .await
}

static CANCEL: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);
static LOGON_URL: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct LogonEvent {
    state: &'static str,
    url: String,
}

/// Stops a browser logon that is waiting for the redirect.
pub fn cancel_logon() {
    if let Some(tx) = CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

/// Opens the logon page of the waiting browser logon again.
pub fn reopen_logon(app: &tauri::AppHandle) -> Result<(), String> {
    let url = LOGON_URL
        .lock()
        .unwrap()
        .clone()
        .ok_or("No logon is waiting")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Browser logon for SAP S/4HANA Cloud Public Edition, SAP BTP ABAP (system URL) and
/// on-premise systems with SAML. The browser opens the reentrance service on the *UI* host
/// (`my123456.s4hana.cloud.sap`, `<id>.abap-web.<region>...`), the user logs on at the
/// identity provider, and the system redirects to localhost with a `reentrance-ticket`.
/// The caller exchanges that ticket for a security session on the *API* host.
pub async fn reentrance_ticket(
    app: &tauri::AppHandle,
    ui_base: &str,
    client: Option<&str>,
    language: Option<&str>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // SAP expects "localhost" here; 127.0.0.1 is rejected by some systems.
    let redirect = format!("http://localhost:{port}/adt/redirect");
    let mut url = format!(
        "{}/sap/bc/sec/reentrance?scenario=FTO1&redirect-url={}",
        ui_base.trim_end_matches('/'),
        urlencode(&redirect)
    );
    if let Some(c) = client.filter(|c| !c.is_empty()) {
        url.push_str(&format!("&sap-client={}", urlencode(c)));
    }
    if let Some(l) = language.filter(|l| !l.is_empty()) {
        url.push_str(&format!("&sap-language={}", urlencode(l)));
    }
    // The window shows the link while it waits, so the user can copy it into another
    // browser or profile, open it again, or cancel.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *CANCEL.lock().unwrap() = Some(tx);
    *LOGON_URL.lock().unwrap() = Some(url.clone());
    let _ = app.emit(
        "browser-logon",
        LogonEvent {
            state: "waiting",
            url: url.clone(),
        },
    );
    let _ = app.opener().open_url(url.clone(), None::<&str>);
    let res = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(300), wait_for_param(&listener, "reentrance-ticket")) =>
            r.map_err(|_| "Browser logon timed out after 5 minutes".to_string()).and_then(|x| x),
        _ = rx => Err("Browser logon was cancelled".to_string()),
    };
    CANCEL.lock().unwrap().take();
    LOGON_URL.lock().unwrap().take();
    let _ = app.emit("browser-logon", LogonEvent { state: "done", url });
    let ticket = res?;
    Ok(percent_decode(&ticket))
}

async fn wait_for_param(listener: &TcpListener, name: &str) -> Result<String, String> {
    let prefix = format!("{name}=");
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = head
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        if !target.starts_with("/adt/redirect") {
            let _ = sock
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .await;
            continue;
        }
        let code = target
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .find_map(|kv| kv.strip_prefix(prefix.as_str()))
            .map(|s| s.to_string());
        let page = if code.is_some() {
            "<h3>Nusa Studio is logged in. You can close this tab.</h3>"
        } else {
            "<h3>Login was not completed. Return to Nusa Studio and try again.</h3>"
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            page.len(),
            page
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        return code.ok_or_else(|| "Login was cancelled".to_string());
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// API and UI origins of a system from whatever the user typed: a Fiori launchpad link
/// (`https://my123456.s4hana.cloud.sap/ui#Shell-home`), the API URL, or a BTP host.
/// S/4HANA Cloud serves ADT on `<tenant>-api.<domain>` and logon pages on `<tenant>.<domain>`;
/// BTP ABAP serves ADT on `<id>.abap.<region>` and logon pages on `<id>.abap-web.<region>`.
pub fn system_hosts(raw: &str) -> (String, String) {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    let Ok(u) = reqwest::Url::parse(raw.trim()) else {
        return (trimmed.clone(), trimmed);
    };
    let host = u.host_str().unwrap_or("").to_lowercase();
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    let (first, rest) = host.split_once('.').unwrap_or((host.as_str(), ""));
    let (api, ui) = if rest.starts_with("s4hana.") {
        let tenant = first.trim_end_matches("-api");
        (format!("{tenant}-api.{rest}"), format!("{tenant}.{rest}"))
    } else if host.contains(".abap-web.") {
        (host.replacen(".abap-web.", ".abap.", 1), host.clone())
    } else if host.contains(".abap.") {
        (host.clone(), host.replacen(".abap.", ".abap-web.", 1))
    } else {
        (host.clone(), host.clone())
    };
    let scheme = u.scheme();
    (
        format!("{scheme}://{api}{port}"),
        format!("{scheme}://{ui}{port}"),
    )
}

#[cfg(test)]
mod tests {
    use super::system_hosts;

    #[test]
    fn hosts_from_launchpad_and_api_urls() {
        let want = (
            "https://my408355-api.s4hana.cloud.sap".to_string(),
            "https://my408355.s4hana.cloud.sap".to_string(),
        );
        assert_eq!(
            system_hosts("https://my408355.s4hana.cloud.sap/ui#Shell-home"),
            want
        );
        assert_eq!(system_hosts("https://my408355-api.s4hana.cloud.sap/"), want);
        assert_eq!(
            system_hosts("https://1a2b.abap.eu10.hana.ondemand.com"),
            (
                "https://1a2b.abap.eu10.hana.ondemand.com".to_string(),
                "https://1a2b.abap-web.eu10.hana.ondemand.com".to_string()
            )
        );
        assert_eq!(
            system_hosts("https://s4d.example.com:44300/sap/bc/gui"),
            (
                "https://s4d.example.com:44300".to_string(),
                "https://s4d.example.com:44300".to_string()
            )
        );
    }
}
