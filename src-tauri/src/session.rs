//! HTTP session per SAP connection.
//!
//! ADT needs two things a browser fetch cannot give us: cookie-bound CSRF tokens and a
//! *stateful* session that keeps enqueue locks alive between LOCK, PUT and UNLOCK.
//! Each connection therefore owns two cookie jars: one stateless, one stateful.

use crate::connections::{Auth, Connection, Kind};
use crate::oauth;
use crate::rfc;
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method, Url};
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
    jars: [Arc<Jar>; 2],
    bearer: Mutex<Option<oauth::Token>>,
    /// Reentrance ticket from the browser logon (MYSAPSSO2), for Auth::Sso.
    sso: Mutex<Option<String>>,
    /// Auth::Rfc: open RFC connections, one for plain requests and one for locks.
    rfc: [Arc<std::sync::Mutex<Option<rfc::RfcConn>>>; 3],
    /// Set after a rejected RFC logon: no further attempts until the system is saved again,
    /// so a wrong password cannot lock the user with a burst of parallel requests.
    rfc_refused: Arc<std::sync::Mutex<Option<String>>>,
}

fn build_client(conn: &Connection, jar: Arc<Jar>) -> Result<Client, String> {
    let mut b = Client::builder()
        .cookie_provider(jar)
        .user_agent(concat!("NusaStudio/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15));
    if conn.auth == Auth::Sso {
        // An expired session answers with a redirect to the identity provider; following it
        // would hand an HTML login page to the XML parsers. Treat it as 401 instead.
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    if conn.allow_self_signed.unwrap_or(false) {
        // Opt-in per connection for development systems with self-signed certificates.
        b = b.danger_accept_invalid_certs(true);
    }
    b.build().map_err(|e| e.to_string())
}

impl Session {
    pub fn new(conn: Connection, secret: Option<String>) -> Result<Arc<Self>, String> {
        let jars = [Arc::new(Jar::default()), Arc::new(Jar::default())];
        Ok(Arc::new(Session {
            stateless: Mutex::new(Channel {
                client: build_client(&conn, jars[0].clone())?,
                csrf: None,
            }),
            stateful: Mutex::new(Channel {
                client: build_client(&conn, jars[1].clone())?,
                csrf: None,
            }),
            jars,
            bearer: Mutex::new(None),
            sso: Mutex::new(None),
            rfc: [
                Arc::new(std::sync::Mutex::new(None)),
                Arc::new(std::sync::Mutex::new(None)),
                Arc::new(std::sync::Mutex::new(None)),
            ],
            rfc_refused: Arc::new(std::sync::Mutex::new(None)),
            conn,
            secret,
        }))
    }

    /// Origin for ADT requests. For SAP systems any path the user pasted (a launchpad link
    /// such as `/ui#Shell-home`) is dropped, and S/4HANA Cloud uses its `-api` host.
    fn base(&self) -> String {
        if self.conn.kind == Kind::Runner {
            return self.conn.url.trim_end_matches('/').to_string();
        }
        oauth::system_hosts(&self.conn.url).0
    }

    /// Browser logon: get a reentrance ticket on the UI host, exchange it for a security
    /// session on the API host (stateless jar), then share that session with the stateful jar.
    async fn sso_logon(&self, app: &tauri::AppHandle) -> Result<String, String> {
        let (api, ui) = oauth::system_hosts(&self.conn.url);
        let client = if self.conn.kind == Kind::S4 {
            Some(self.conn.client.as_str())
        } else {
            None
        };
        let ticket =
            oauth::reentrance_ticket(app, &ui, client, Some(self.conn.language.as_str())).await?;
        let probe = build_client(&self.conn, self.jars[0].clone())?;
        let res = probe
            .get(format!("{api}/sap/bc/adt/core/discovery"))
            .query(&self.sap_query())
            .header("MYSAPSSO2", &ticket)
            .header("x-sap-security-session", "create")
            .header("Accept", "application/atomsvc+xml")
            .send()
            .await
            .map_err(|e| net_err(&self.conn, e))?;
        let status = res.status().as_u16();
        if status == 401
            || status == 403
            || res.status().is_redirection()
            || logon_page(res.headers())
        {
            return Err(format!(
                "{} did not accept the browser logon (HTTP {status} from {api}, logon page {ui}). Check that your user has a business role with the developer catalog (SAP_BR_DEVELOPER) and that the URL is the system you logged on to.",
                self.conn.sid
            ));
        }
        let url = Url::parse(&api).map_err(|e| e.to_string())?;
        if let Some(cookies) = self.jars[0].cookies(&url) {
            for part in cookies.to_str().unwrap_or("").split("; ") {
                if !part.is_empty() {
                    self.jars[1].add_cookie_str(&format!("{part}; Path=/"), &url);
                }
            }
        }
        Ok(ticket)
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
            Auth::None | Auth::Rfc => Ok(rb),
            Auth::Basic => Ok(rb.basic_auth(&self.conn.user, self.secret.as_deref())),
            Auth::Sso => {
                let mut ticket = self.sso.lock().await;
                if ticket.is_none() {
                    *ticket = Some(self.sso_logon(app).await?);
                }
                Ok(rb)
            }
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
        let mut attempt = 0;
        let res = loop {
            let rb = ch
                .client
                .get(&url)
                .query(&self.sap_query())
                .header("x-csrf-token", "Fetch")
                .header("Accept", "application/atomsvc+xml")
                .header(
                    "X-sap-adt-sessiontype",
                    if stateful { "stateful" } else { "stateless" },
                );
            let rb = self.auth(rb, app).await?;
            let res = rb.send().await.map_err(|e| net_err(&self.conn, e))?;
            let logon_wanted = self.conn.auth == Auth::Sso
                && (res.status().is_redirection() || logon_page(res.headers()));
            if res.status().as_u16() != 401 && !logon_wanted {
                break res;
            }
            if self.conn.auth == Auth::Sso && attempt == 0 {
                // the browser session expired: log on again once
                *self.sso.lock().await = None;
                attempt += 1;
                continue;
            }
            return Err(match self.conn.auth {
                Auth::Sso => {
                    *self.sso.lock().await = None;
                    "Browser logon was not accepted (HTTP 401). Check that your user has the developer role (SAP_BR_DEVELOPER on SAP cloud systems) and log in again.".to_string()
                }
                Auth::Oauth => {
                    "Logon failed (HTTP 401). The service key login was not accepted.".to_string()
                }
                _ => "Logon failed (HTTP 401). Check user and password.".to_string(),
            });
        };
        ch.csrf = res
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        Ok(())
    }

    pub async fn request(&self, req: AdtReq, app: &tauri::AppHandle) -> Result<AdtResp, String> {
        if self.conn.auth == Auth::Rfc {
            return self.rfc_request(req).await;
        }
        let chan = if req.stateful {
            &self.stateful
        } else {
            &self.stateless
        };
        let modifying = req.method != "GET";
        let mut guard = chan.lock().await;
        if modifying && guard.csrf.is_none() && self.conn.kind != Kind::Runner {
            self.fetch_csrf(&mut guard, req.stateful, app).await?;
        }
        // Stateful requests keep the channel for their whole run: they share one SAP session and
        // must stay in order (lock, write, unlock; debugger steps). Stateless ones let it go, so
        // a debugger listener or a slow query does not hold up the rest.
        let mut snap = Channel {
            client: guard.client.clone(),
            csrf: guard.csrf.clone(),
        };
        let mut held = if req.stateful {
            Some(guard)
        } else {
            drop(guard);
            None
        };
        for attempt in 0..2 {
            let ticket = if self.conn.auth == Auth::Sso {
                self.sso.lock().await.clone()
            } else {
                None
            };
            let res = self.send_once(&snap, &req, app).await?;
            let csrf_required = res.status == 403
                && res
                    .headers
                    .get("x-csrf-token")
                    .map(|v| v.eq_ignore_ascii_case("required"))
                    .unwrap_or(false);
            if csrf_required && attempt == 0 {
                snap.csrf = self
                    .refresh_csrf(chan, &mut held, req.stateful, app)
                    .await?;
                continue;
            }
            if res.status == 401 && attempt == 0 && self.conn.auth == Auth::Oauth {
                *self.bearer.lock().await = None;
                continue;
            }
            if res.status == 401 && attempt == 0 && self.conn.auth == Auth::Sso {
                // ticket or session expired: log on again through the browser, once, even when
                // several requests notice it at the same time
                {
                    let mut t = self.sso.lock().await;
                    if *t == ticket {
                        *t = None;
                    }
                }
                snap.csrf = if modifying && self.conn.kind != Kind::Runner {
                    self.refresh_csrf(chan, &mut held, req.stateful, app)
                        .await?
                } else {
                    None
                };
                continue;
            }
            return Ok(res);
        }
        Err("Request failed after retry".into())
    }

    /// Fetches a new CSRF token into the shared channel and returns it.
    async fn refresh_csrf(
        &self,
        chan: &Mutex<Channel>,
        held: &mut Option<tokio::sync::MutexGuard<'_, Channel>>,
        stateful: bool,
        app: &tauri::AppHandle,
    ) -> Result<Option<String>, String> {
        match held.as_mut() {
            Some(g) => {
                g.csrf = None;
                self.fetch_csrf(g, stateful, app).await?;
                Ok(g.csrf.clone())
            }
            None => {
                let mut g = chan.lock().await;
                g.csrf = None;
                self.fetch_csrf(&mut g, stateful, app).await?;
                Ok(g.csrf.clone())
            }
        }
    }

    /// ADT over RFC (SADT_REST_RFC_ENDPOINT), like Eclipse for on-premise systems. The
    /// connections stay open: each new one is a logon, and the stateful one keeps the locks.
    /// No CSRF token is needed: the RFC logon already authenticates every call.
    async fn rfc_request(&self, req: AdtReq) -> Result<AdtResp, String> {
        let c = &self.conn;
        let sdk_dir = c.rfc_sdk.clone().unwrap_or_default();
        let logon = rfc::Logon {
            ashost: c.ashost.clone().unwrap_or_default(),
            sysnr: c.sysnr.clone().unwrap_or_default(),
            client: c.client.clone(),
            user: c.user.clone(),
            password: self.secret.clone().unwrap_or_default(),
            language: if c.language.is_empty() {
                "EN".into()
            } else {
                c.language.clone()
            },
            saprouter: c.saprouter.clone().unwrap_or_default(),
        };
        let sid = c.sid.clone();
        // the debugger listener waits for minutes: it gets its own connection
        let listener = req.method == "POST" && req.path.ends_with("/debugger/listeners");
        let slot = self.rfc[if req.stateful {
            1
        } else if listener {
            2
        } else {
            0
        }]
        .clone();
        let refused = self.rfc_refused.clone();
        // URI with the query string, as the HTTP request line would carry it. Same parsing as the HTTP route, so already-encoded names (%2F namespaces) stay as they are
        let mut url =
            Url::parse(&format!("http://rfc.local{}", req.path)).map_err(|e| e.to_string())?;
        if !req.query.is_empty() {
            url.query_pairs_mut().extend_pairs(req.query.iter());
        }
        let uri = match url.query() {
            Some(q) => format!("{}?{}", url.path(), q),
            None => url.path().to_string(),
        };
        let mut headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("accept"))
        {
            headers.push(("Accept".into(), "*/*".into())); // some ADT resources reject requests without it
        }
        headers.push((
            "X-sap-adt-sessiontype".into(),
            if req.stateful {
                "stateful"
            } else {
                "stateless"
            }
            .into(),
        ));
        let method = req.method.clone();
        let body = req.body.clone().unwrap_or_default().into_bytes();
        let res = tokio::task::spawn_blocking(move || -> Result<rfc::RestResponse, String> {
            let sdk = rfc::load(&sdk_dir)?;
            let mut guard = slot
                .lock()
                .map_err(|_| "RFC connection lock poisoned".to_string())?;
            for attempt in 0..2 {
                if guard.is_none() {
                    // held while logging on: parallel requests wait instead of each trying a logon
                    let mut no = refused
                        .lock()
                        .map_err(|_| "RFC logon lock poisoned".to_string())?;
                    if let Some(msg) = no.as_ref() {
                        return Err(msg.clone());
                    }
                    match rfc::RfcConn::open(sdk.clone(), &logon) {
                        Ok(c) => *guard = Some(c),
                        Err(e) => {
                            let msg = e.user_text(&sid);
                            if e.code == rfc::RFC_LOGON_FAILURE {
                                *no = Some(msg.clone());
                            }
                            return Err(msg);
                        }
                    }
                }
                let res = guard.as_ref().unwrap().rest(&method, &uri, &headers, &body);
                match res {
                    Ok(r) => return Ok(r),
                    Err(e) if e.broken() && attempt == 0 => {
                        *guard = None; // dropped connection: open a new one once
                    }
                    Err(e) => return Err(e.user_text(&sid)),
                }
            }
            Err(format!("{sid} could not be reached over RFC"))
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(AdtResp {
            status: res.status,
            headers: res.headers.into_iter().collect(),
            body: String::from_utf8_lossy(&res.body).into_owned(),
        })
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
        let mut status = res.status().as_u16();
        if self.conn.auth == Auth::Sso
            && (res.status().is_redirection() || logon_page(res.headers()))
        {
            status = 401; // session gone: the system wants an interactive logon
        }
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

/// SAP answers an unauthenticated request with an HTML logon form marked by this header.
fn logon_page(h: &HeaderMap) -> bool {
    h.get("sap-err-id")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("ICFLOGONREQUIRED"))
        .unwrap_or(false)
}

fn net_err(conn: &Connection, e: reqwest::Error) -> String {
    let local = ["://localhost", "://127.0.0.1", "://[::1]"]
        .iter()
        .any(|h| conn.url.to_lowercase().contains(h));
    if e.is_timeout() {
        format!("{} did not answer in time ({}).", conn.sid, conn.url)
    } else if e.is_connect() && conn.kind == Kind::Runner {
        format!(
            "No ABAP runner is running at {}. Start the runner on this laptop, \
             or open the DEMO system or add an SAP system under Systems.",
            conn.url
        )
    } else if e.is_connect() && local {
        format!(
            "Nothing is listening at {}. Check that the program is running and the port is right.",
            conn.url
        )
    } else if e.is_connect() {
        format!(
            "Cannot reach {} at {}. Check VPN, host and port.",
            conn.sid, conn.url
        )
    } else {
        format!("{}: {}", conn.sid, e)
    }
}
