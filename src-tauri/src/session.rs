//! HTTP session per SAP connection.
//!
//! ADT needs two things a browser fetch cannot give us: cookie-bound CSRF tokens and a
//! *stateful* session that keeps enqueue locks alive between LOCK, PUT and UNLOCK.
//! Each connection therefore owns two cookie jars: one stateless, one stateful.

use crate::connections::{Auth, Connection, Kind};
use crate::oauth;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdtReq {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: HashMap<String, String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    #[serde(default)]
    pub stateful: bool,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct AdtResp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

struct Channel {
    client: Client,
    csrf: Option<String>,
}

pub struct Session {
    conn: Connection,
    secret: Option<String>,
    stateless: Mutex<Channel>,
    stateful: Mutex<Channel>,
    bearer: Mutex<Option<oauth::Token>>,
}

fn build_client(conn: &Connection) -> Result<Client, String> {
    let mut b = Client::builder()
        .cookie_store(true)
        .user_agent(concat!("NusaADT/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15));
    if conn.allow_self_signed.unwrap_or(false) {
        // Opt-in per connection for development systems with self-signed certificates.
        b = b.danger_accept_invalid_certs(true);
    }
    b.build().map_err(|e| e.to_string())
}

impl Session {
    pub fn new(conn: Connection, secret: Option<String>) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Session {
            stateless: Mutex::new(Channel {
                client: build_client(&conn)?,
                csrf: None,
            }),
            stateful: Mutex::new(Channel {
                client: build_client(&conn)?,
                csrf: None,
            }),
            bearer: Mutex::new(None),
            conn,
            secret,
        }))
    }

    fn base(&self) -> String {
        self.conn.url.trim_end_matches('/').to_string()
    }

    fn sap_query(&self) -> Vec<(String, String)> {
        let mut q = vec![];
        if self.conn.kind == Kind::S4 && !self.conn.client.is_empty() {
            q.push(("sap-client".into(), self.conn.client.clone()));
        }
        if !self.conn.language.is_empty() && self.conn.kind != Kind::Runner {
            q.push(("sap-language".into(), self.conn.language.clone()));
        }
        q
    }

    async fn auth(
        &self,
        rb: reqwest::RequestBuilder,
        app: &tauri::AppHandle,
    ) -> Result<reqwest::RequestBuilder, String> {
        match self.conn.auth {
            Auth::None => Ok(rb),
            Auth::Basic => Ok(rb.basic_auth(&self.conn.user, self.secret.as_deref())),
            Auth::Oauth => {
                let mut tok = self.bearer.lock().await;
                let need_login = tok.as_ref().map(|t| t.expired()).unwrap_or(true);
                if need_login {
                    let key = self
                        .secret
                        .as_deref()
                        .ok_or("This BTP system has no service key saved. Add it under Systems.")?;
                    let refreshed = match tok.as_ref().and_then(|t| t.refresh_token.clone()) {
                        Some(rt) => oauth::refresh(key, &rt).await.ok(),
                        None => None,
                    };
                    *tok = Some(match refreshed {
                        Some(t) => t,
                        None => oauth::login(app, key).await?,
                    });
                }
                Ok(rb.bearer_auth(&tok.as_ref().unwrap().access_token))
            }
        }
    }

    async fn fetch_csrf(
        &self,
        ch: &mut Channel,
        stateful: bool,
        app: &tauri::AppHandle,
    ) -> Result<(), String> {
        let url = format!("{}/sap/bc/adt/core/discovery", self.base());
        let mut rb = ch
            .client
            .get(&url)
            .query(&self.sap_query())
            .header("x-csrf-token", "Fetch")
            .header("Accept", "application/atomsvc+xml");
        rb = rb.header(
            "X-sap-adt-sessiontype",
            if stateful { "stateful" } else { "stateless" },
        );
        let rb = self.auth(rb, app).await?;
        let res = rb.send().await.map_err(|e| net_err(&self.conn, e))?;
        if res.status().as_u16() == 401 {
            return Err("Logon failed (HTTP 401). Check user and password.".into());
        }
        ch.csrf = res
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        Ok(())
    }

    pub async fn request(&self, req: AdtReq, app: &tauri::AppHandle) -> Result<AdtResp, String> {
        let chan = if req.stateful {
            &self.stateful
        } else {
            &self.stateless
        };
        let mut ch = chan.lock().await;
        let modifying = req.method != "GET";
        if modifying && ch.csrf.is_none() && self.conn.kind != Kind::Runner {
            self.fetch_csrf(&mut ch, req.stateful, app).await?;
        }
        for attempt in 0..2 {
            let res = self.send_once(&ch, &req, app).await?;
            let csrf_required = res.status == 403
                && res
                    .headers
                    .get("x-csrf-token")
                    .map(|v| v.eq_ignore_ascii_case("required"))
                    .unwrap_or(false);
            if csrf_required && attempt == 0 {
                self.fetch_csrf(&mut ch, req.stateful, app).await?;
                continue;
            }
            if res.status == 401 && attempt == 0 && self.conn.auth == Auth::Oauth {
                *self.bearer.lock().await = None;
                continue;
            }
            return Ok(res);
        }
        Err("Request failed after retry".into())
    }

    async fn send_once(
        &self,
        ch: &Channel,
        req: &AdtReq,
        app: &tauri::AppHandle,
    ) -> Result<AdtResp, String> {
        let method = Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
        let url = format!("{}{}", self.base(), req.path);
        let mut query: Vec<(String, String)> = self.sap_query();
        query.extend(req.query.iter().map(|(k, v)| (k.clone(), v.clone())));
        let mut headers = HeaderMap::new();
        for (k, v) in &req.headers {
            if let (Ok(n), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(n, val);
            }
        }
        headers.insert(
            "X-sap-adt-sessiontype",
            HeaderValue::from_static(if req.stateful {
                "stateful"
            } else {
                "stateless"
            }),
        );
        if let Some(t) = &ch.csrf {
            if let Ok(v) = HeaderValue::from_str(t) {
                headers.insert("x-csrf-token", v);
            }
        }
        let mut rb = ch
            .client
            .request(method, &url)
            .query(&query)
            .headers(headers)
            .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(120_000)));
        if let Some(b) = &req.body {
            rb = rb.body(b.clone());
        }
        let rb = self.auth(rb, app).await?;
        let res = rb.send().await.map_err(|e| net_err(&self.conn, e))?;
        let status = res.status().as_u16();
        let headers = res
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_lowercase(),
                    v.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        Ok(AdtResp {
            status,
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        })
    }
}

fn net_err(conn: &Connection, e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{} did not answer in time", conn.sid)
    } else if e.is_connect() {
        format!(
            "Cannot reach {} at {}. Check VPN, host and port.",
            conn.sid, conn.url
        )
    } else {
        format!("{}: {}", conn.sid, e)
    }
}
