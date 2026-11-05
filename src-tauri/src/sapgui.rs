//! Running reports the way Eclipse does on on-premise systems: in SAP GUI. Nusa Studio writes
//! an SAP GUI shortcut (.sap) that starts SE38 with the program and F8, and opens it, so the
//! installed SAP GUI logs on to the same system (with single sign-on, or asking for the
//! password; shortcuts never carry one).

use crate::connections::{Auth, Connection};
use std::path::PathBuf;

/// The shortcut file's text. `command` is an OK code line such as
/// `*SE38 RS38M-PROGRAMM=ZREPORT;DYNP_OKCODE=STRT`.
pub fn shortcut(c: &Connection, command: &str) -> String {
    let mut s = String::from("[System]\r\n");
    s += &format!("Name={}\r\n", c.sid);
    if !c.client.is_empty() {
        s += &format!("Client={}\r\n", c.client);
    }
    if c.auth == Auth::Rfc {
        // the same route SAP GUI uses: SAProuter hops, then the dispatcher port 32NN
        if let (Some(host), Some(nr)) = (c.ashost.as_deref(), c.sysnr.as_deref()) {
            let router = c.saprouter.as_deref().unwrap_or("").trim();
            s += &format!("GuiParm={router}/H/{host}/S/32{nr:0>2}\r\n");
        }
    }
    s += "[User]\r\n";
    if !c.user.is_empty() {
        s += &format!("Name={}\r\n", c.user);
    }
    if !c.language.is_empty() {
        s += &format!("Language={}\r\n", c.language);
    }
    s += "[Function]\r\nTitle=Nusa Studio\r\n";
    s += &format!("Command={command}\r\nType=Transaction\r\n");
    s += "[Configuration]\r\nGuiSize=Maximized\r\n[Options]\r\nReuse=1\r\n";
    s
}

fn open(path: &PathBuf) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        c.arg(path);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the SAP GUI shortcut: {e}. Is SAP GUI installed?"))
}

/// Writes the shortcut to the temp folder and opens it with SAP GUI. Returns the file path.
#[tauri::command]
pub fn open_sap_gui(conn: Connection, command: String) -> Result<String, String> {
    let safe: String = command
        .chars()
        .skip_while(|c| *c != '=')
        .skip(1)
        .take_while(|c| *c != ';')
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let path = std::env::temp_dir().join(format!("Nusa-{}-{}.sap", conn.sid, safe));
    std::fs::write(&path, shortcut(&conn, &command)).map_err(|e| e.to_string())?;
    open(&path)?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::Kind;

    fn conn(auth: Auth) -> Connection {
        Connection {
            id: "lnp".into(),
            kind: Kind::S4,
            sid: "LNP".into(),
            client: "240".into(),
            user: "SAPANDRA".into(),
            url: String::new(),
            language: "EN".into(),
            auth,
            abap_version: "standard".into(),
            favorite_packages: vec![],
            transports: true,
            label: None,
            allow_self_signed: None,
            ashost: Some("10.27.1.2".into()),
            sysnr: Some("20".into()),
            saprouter: Some("/H/36.92.53.190/S/3299/W/PC".into()),
            rfc_sdk: None,
        }
    }

    #[test]
    fn shortcut_starts_se38_through_the_same_route() {
        let s = shortcut(
            &conn(Auth::Rfc),
            "*SE38 RS38M-PROGRAMM=ZR_X;DYNP_OKCODE=STRT",
        );
        assert!(s.contains(
            "Name=LNP\r\nClient=240\r\nGuiParm=/H/36.92.53.190/S/3299/W/PC/H/10.27.1.2/S/3220\r\n"
        ));
        assert!(s.contains("[User]\r\nName=SAPANDRA\r\nLanguage=EN\r\n"));
        assert!(
            s.contains("Command=*SE38 RS38M-PROGRAMM=ZR_X;DYNP_OKCODE=STRT\r\nType=Transaction")
        );
        assert!(!s.to_lowercase().contains("password"));
        let https = shortcut(
            &conn(Auth::Basic),
            "*SE38 RS38M-PROGRAMM=ZR_X;DYNP_OKCODE=STRT",
        );
        assert!(
            !https.contains("GuiParm"),
            "HTTPS systems are found by their SID in SAP Logon"
        );
    }
}
