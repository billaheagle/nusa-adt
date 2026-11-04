//! ADT over RFC, the way Eclipse ADT reaches on-premise systems: every ADT REST request is
//! sent through function module SADT_REST_RFC_ENDPOINT. RFC understands SAProuter route
//! strings, so systems behind a SAProuter work without HTTP access.
//!
//! The SAP NetWeaver RFC SDK is SAP software the user downloads from the SAP Software
//! Center; it cannot be shipped with the app, so it is loaded at run time from the folder
//! the user configures.

use libloading::Library;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

type Uc = u16; // SAP_UC: UTF-16 on every platform
type Handle = *mut c_void;

const RFC_OK: i32 = 0;
const RFC_COMMUNICATION_FAILURE: i32 = 1;
pub const RFC_LOGON_FAILURE: i32 = 2;
const RFC_CLOSED: i32 = 6;
const RFC_BUFFER_TOO_SMALL: i32 = 23;
const RFC_INVALID_HANDLE: i32 = 13;

#[repr(C)]
struct ErrorInfo {
    code: i32,
    group: i32,
    key: [Uc; 128],
    message: [Uc; 512],
    abap_msg_class: [Uc; 21],
    abap_msg_type: [Uc; 2],
    abap_msg_number: [Uc; 4],
    v1: [Uc; 51],
    v2: [Uc; 51],
    v3: [Uc; 51],
    v4: [Uc; 51],
}

impl ErrorInfo {
    fn new() -> Self {
        // SAFETY: plain C struct of integers and arrays; all-zero is a valid value.
        unsafe { std::mem::zeroed() }
    }
    fn text(&self) -> String {
        let msg = from_uc(&self.message);
        let key = from_uc(&self.key);
        if msg.is_empty() {
            key
        } else {
            msg
        }
    }
}

#[repr(C)]
struct ConnParam {
    name: *const Uc,
    value: *const Uc,
}

fn uc(s: &str) -> Vec<Uc> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
fn from_uc(b: &[Uc]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..end]).trim().to_string()
}

type FnOpen = unsafe extern "C" fn(*const ConnParam, u32, *mut ErrorInfo) -> Handle;
type FnClose = unsafe extern "C" fn(Handle, *mut ErrorInfo) -> i32;
type FnDesc = unsafe extern "C" fn(Handle, *const Uc, *mut ErrorInfo) -> Handle;
type FnCreate = unsafe extern "C" fn(Handle, *mut ErrorInfo) -> Handle;
type FnDestroy = unsafe extern "C" fn(Handle, *mut ErrorInfo) -> i32;
type FnInvoke = unsafe extern "C" fn(Handle, Handle, *mut ErrorInfo) -> i32;
type FnGetChild = unsafe extern "C" fn(Handle, *const Uc, *mut Handle, *mut ErrorInfo) -> i32;
type FnAppendRow = unsafe extern "C" fn(Handle, *mut ErrorInfo) -> Handle;
type FnSetString = unsafe extern "C" fn(Handle, *const Uc, *const Uc, u32, *mut ErrorInfo) -> i32;
type FnSetXString = unsafe extern "C" fn(Handle, *const Uc, *const u8, u32, *mut ErrorInfo) -> i32;
type FnGetString =
    unsafe extern "C" fn(Handle, *const Uc, *mut Uc, u32, *mut u32, *mut ErrorInfo) -> i32;
type FnGetLen = unsafe extern "C" fn(Handle, *const Uc, *mut u32, *mut ErrorInfo) -> i32;
type FnGetXString =
    unsafe extern "C" fn(Handle, *const Uc, *mut u8, u32, *mut u32, *mut ErrorInfo) -> i32;
type FnRowCount = unsafe extern "C" fn(Handle, *mut u32, *mut ErrorInfo) -> i32;
type FnMoveTo = unsafe extern "C" fn(Handle, u32, *mut ErrorInfo) -> i32;
type FnCurrentRow = unsafe extern "C" fn(Handle, *mut ErrorInfo) -> Handle;

/// The loaded SDK and the functions Nusa Studio calls.
pub struct Sdk {
    _lib: Library,
    open: FnOpen,
    close: FnClose,
    desc: FnDesc,
    create: FnCreate,
    destroy: FnDestroy,
    invoke: FnInvoke,
    get_structure: FnGetChild,
    get_table: FnGetChild,
    append_row: FnAppendRow,
    set_string: FnSetString,
    set_xstring: FnSetXString,
    get_string: FnGetString,
    get_len: FnGetLen,
    get_xstring: FnGetXString,
    row_count: FnRowCount,
    move_to: FnMoveTo,
    current_row: FnCurrentRow,
}
// SAFETY: the NW RFC SDK is thread-safe; a connection is used by one thread at a time
// (it sits behind a mutex).
unsafe impl Send for Sdk {}
unsafe impl Sync for Sdk {}

const LIB_NAME: &str = if cfg!(windows) {
    "sapnwrfc.dll"
} else if cfg!(target_os = "macos") {
    "libsapnwrfc.dylib"
} else {
    "libsapnwrfc.so"
};

/// Finds the SDK library in the folder the user picked: the SDK root, its lib folder, the
/// folder the ZIP was extracted to, or deeper (Windows "Extract all" adds a folder level).
pub fn find_library(dir: &str) -> Option<PathBuf> {
    let d = Path::new(dir.trim().trim_matches('"'));
    let direct = [
        d.join(LIB_NAME),
        d.join("lib").join(LIB_NAME),
        d.join("nwrfcsdk").join("lib").join(LIB_NAME),
    ];
    if let Some(p) = direct.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    search(d, 4, &|n| n.eq_ignore_ascii_case(LIB_NAME))
}

fn search(dir: &Path, depth: u32, want: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    for e in &entries {
        let p = e.path();
        if p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(want) {
            return Some(p);
        }
    }
    if depth == 0 {
        return None;
    }
    entries
        .iter()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .find_map(|p| search(&p, depth - 1, want))
}

/// Why the folder has no usable SDK, in words the user can act on.
fn not_found(dir: &str) -> String {
    let d = Path::new(dir.trim().trim_matches('"'));
    let platform = if cfg!(windows) {
        "Windows on x64 64bit"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux on x86_64 64bit"
    };
    if !d.is_dir() {
        return format!("The folder \"{dir}\" does not exist. Choose the folder where you extracted the SAP NW RFC SDK (it contains lib\\{LIB_NAME}).");
    }
    // an SDK for another operating system: same layout, other file names
    let other = ["sapnwrfc.dll", "libsapnwrfc.so", "libsapnwrfc.dylib"]
        .into_iter()
        .filter(|n| *n != LIB_NAME)
        .find_map(|n| search(d, 4, &|f| f.eq_ignore_ascii_case(n)));
    if let Some(p) = other {
        return format!("\"{dir}\" holds the RFC SDK for another operating system ({}). Download SAP NW RFC SDK 7.50 for {platform} and extract it here.", p.display());
    }
    let sar = search(d, 2, &|f| f.to_ascii_lowercase().ends_with(".sar"));
    if let Some(p) = sar {
        return format!("{} is still packed. Extract it with SAPCAR (sapcar -xvf <file>.SAR), then choose the extracted folder.", p.display());
    }
    let seen: Vec<String> = std::fs::read_dir(d)
        .map(|r| {
            r.flatten()
                .take(12)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    format!("The SAP NW RFC SDK was not found in \"{dir}\" (it contains: {}). Choose the folder that contains lib\\{LIB_NAME}, from SAP NW RFC SDK 7.50 for {platform}.", if seen.is_empty() { "nothing".to_string() } else { seen.join(", ") })
}

static LOADED: Mutex<Option<(PathBuf, Arc<Sdk>)>> = Mutex::new(None);

pub fn load(dir: &str) -> Result<Arc<Sdk>, String> {
    let path = find_library(dir).ok_or_else(|| not_found(dir))?;
    let mut cache = LOADED.lock().unwrap();
    if let Some((p, sdk)) = cache.as_ref() {
        if *p == path {
            return Ok(sdk.clone());
        }
    }
    let lib = open_library(&path)?;
    macro_rules! sym {
        ($name:literal, $t:ty) => {
            // SAFETY: the symbol is a C function with the signature declared in sapnwrfc.h.
            unsafe {
                *lib.get::<$t>(concat!($name, "\0").as_bytes())
                    .map_err(|e| format!("{} is missing in the RFC SDK: {e}", $name))?
            }
        };
    }
    let sdk = Arc::new(Sdk {
        open: sym!("RfcOpenConnection", FnOpen),
        close: sym!("RfcCloseConnection", FnClose),
        desc: sym!("RfcGetFunctionDesc", FnDesc),
        create: sym!("RfcCreateFunction", FnCreate),
        destroy: sym!("RfcDestroyFunction", FnDestroy),
        invoke: sym!("RfcInvoke", FnInvoke),
        get_structure: sym!("RfcGetStructure", FnGetChild),
        get_table: sym!("RfcGetTable", FnGetChild),
        append_row: sym!("RfcAppendNewRow", FnAppendRow),
        set_string: sym!("RfcSetString", FnSetString),
        set_xstring: sym!("RfcSetXString", FnSetXString),
        get_string: sym!("RfcGetString", FnGetString),
        get_len: sym!("RfcGetStringLength", FnGetLen),
        get_xstring: sym!("RfcGetXString", FnGetXString),
        row_count: sym!("RfcGetRowCount", FnRowCount),
        move_to: sym!("RfcMoveTo", FnMoveTo),
        current_row: sym!("RfcGetCurrentRow", FnCurrentRow),
        _lib: lib,
    });
    *cache = Some((path, sdk.clone()));
    Ok(sdk)
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetDllDirectoryW(path: *const u16) -> i32;
}

#[cfg(windows)]
fn open_library(path: &Path) -> Result<Library, String> {
    // The SDK loads its ICU DLLs (icuuc57.dll, icudt57.dll, icuin57.dll) itself while it
    // initialises, looking along PATH; without this it shows "I18N Initialization: Could not
    // open the ICU common library". Put the SDK's lib folder first on this process's PATH and
    // in the DLL search path, as if the user had added it to PATH by hand.
    if let Some(dir) = path.parent() {
        let old = std::env::var_os("PATH").unwrap_or_default();
        let already = std::env::split_paths(&old).any(|p| p == dir);
        if !already {
            let mut parts = vec![dir.to_path_buf()];
            parts.extend(std::env::split_paths(&old));
            if let Ok(joined) = std::env::join_paths(parts) {
                std::env::set_var("PATH", joined);
            }
        }
        let wide: Vec<u16> = dir
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: wide is NUL-terminated and lives for the call.
        unsafe { SetDllDirectoryW(wide.as_ptr()) };
    }
    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;
    // SAFETY: loading a library runs its initialisers; this is SAP's own SDK chosen by the user.
    unsafe {
        libloading::os::windows::Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
    }
    .map(Library::from)
    .map_err(|e| format!("Could not load {}: {e}. If it names a missing DLL such as MSVCP140.dll, install the Microsoft Visual C++ Redistributable (x64).", path.display()))
}

#[cfg(not(windows))]
fn open_library(path: &Path) -> Result<Library, String> {
    // SAFETY: as above.
    unsafe { Library::new(path) }.map_err(|e| format!("Could not load {}: {e}", path.display()))
}

/// Logon data of an RFC connection (the SAP GUI logon pad entry plus user and password).
#[derive(Clone)]
pub struct Logon {
    pub ashost: String,
    pub sysnr: String,
    pub client: String,
    pub user: String,
    pub password: String,
    pub language: String,
    pub saprouter: String,
}

#[derive(Debug)]
pub struct RfcError {
    pub code: i32,
    pub message: String,
}
impl RfcError {
    fn from(e: &ErrorInfo) -> Self {
        RfcError {
            code: e.code,
            message: e.text(),
        }
    }
    /// The connection is gone and opening a new one may help.
    pub fn broken(&self) -> bool {
        matches!(
            self.code,
            RFC_COMMUNICATION_FAILURE | RFC_CLOSED | RFC_INVALID_HANDLE
        )
    }
    pub fn user_text(&self, sid: &str) -> String {
        match self.code {
            RFC_LOGON_FAILURE => format!("{sid} did not accept the logon: {}. Check client, user and password; too many wrong passwords lock the user.", self.message),
            RFC_COMMUNICATION_FAILURE => format!("{sid} could not be reached over RFC: {}. Check the application server, instance number and SAProuter string (the same values as in the SAP GUI logon pad).", self.message),
            _ if self.message.contains("SADT_REST_RFC_ENDPOINT")
                && (self.message.contains("046") || self.message.to_lowercase().contains("not found")) =>
            {
                format!("Logged on to {sid}, but it has no ADT service (function module SADT_REST_RFC_ENDPOINT is missing). ABAP Development Tools need SAP_BASIS 7.31 SP04 or newer, so Eclipse ADT cannot work with this system either. Check SAP_BASIS in SAP GUI under System → Status → Component information. ({})", self.message)
            }
            _ if self.message.contains("S_RFC") => format!("{sid}: {}. Your user needs S_RFC for function group SADT_REST_RFC, the same as for Eclipse (role SAP_BC_DWB_ABAPDEVELOPER).", self.message),
            _ => format!("{sid}: {}", self.message),
        }
    }
}

/// One open RFC connection (one SAP user session). Kept open: every new connection is a
/// logon, and the stateful one holds the enqueue locks between LOCK, PUT and UNLOCK.
pub struct RfcConn {
    sdk: Arc<Sdk>,
    h: Handle,
}
// SAFETY: used by one thread at a time behind a mutex; the SDK allows moving handles between threads.
unsafe impl Send for RfcConn {}

impl Drop for RfcConn {
    fn drop(&mut self) {
        let mut e = ErrorInfo::new();
        // SAFETY: h is a live connection handle from RfcOpenConnection.
        unsafe { (self.sdk.close)(self.h, &mut e) };
    }
}

pub struct RestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RfcConn {
    pub fn open(sdk: Arc<Sdk>, l: &Logon) -> Result<RfcConn, RfcError> {
        let mut pairs: Vec<(&str, &str)> = vec![
            ("ashost", l.ashost.as_str()),
            ("sysnr", l.sysnr.as_str()),
            ("client", l.client.as_str()),
            ("user", l.user.as_str()),
            ("passwd", l.password.as_str()),
            ("lang", l.language.as_str()),
        ];
        if !l.saprouter.trim().is_empty() {
            pairs.push(("saprouter", l.saprouter.trim()));
        }
        let owned: Vec<(Vec<Uc>, Vec<Uc>)> = pairs.iter().map(|(n, v)| (uc(n), uc(v))).collect();
        let params: Vec<ConnParam> = owned
            .iter()
            .map(|(n, v)| ConnParam {
                name: n.as_ptr(),
                value: v.as_ptr(),
            })
            .collect();
        let mut e = ErrorInfo::new();
        // SAFETY: params point into `owned`, which outlives the call.
        let h = unsafe { (sdk.open)(params.as_ptr(), params.len() as u32, &mut e) };
        if h.is_null() {
            return Err(RfcError::from(&e));
        }
        Ok(RfcConn { sdk, h })
    }

    fn check(&self, rc: i32, e: &ErrorInfo, what: &str) -> Result<(), RfcError> {
        if rc == RFC_OK {
            Ok(())
        } else {
            let mut err = RfcError::from(e);
            if err.message.is_empty() {
                err.message = format!("{what} failed (RFC code {rc})");
            }
            Err(err)
        }
    }

    fn child(&self, f: FnGetChild, parent: Handle, name: &str) -> Result<Handle, RfcError> {
        let mut out: Handle = std::ptr::null_mut();
        let mut e = ErrorInfo::new();
        let n = uc(name);
        // SAFETY: parent is a live data container handle; n is NUL-terminated.
        let rc = unsafe { f(parent, n.as_ptr(), &mut out, &mut e) };
        self.check(rc, &e, name)?;
        Ok(out)
    }

    fn set(&self, c: Handle, name: &str, value: &str) -> Result<(), RfcError> {
        let n = uc(name);
        let v: Vec<Uc> = value.encode_utf16().collect();
        let mut e = ErrorInfo::new();
        // SAFETY: c is a live container; v holds value.len() UTF-16 units.
        let rc =
            unsafe { (self.sdk.set_string)(c, n.as_ptr(), v.as_ptr(), v.len() as u32, &mut e) };
        self.check(rc, &e, name)
    }

    fn get(&self, c: Handle, name: &str) -> Result<String, RfcError> {
        let n = uc(name);
        let mut buf: Vec<Uc> = vec![0; 256];
        loop {
            let mut len: u32 = 0;
            let mut e = ErrorInfo::new();
            // SAFETY: buf has buf.len() units; the SDK writes at most that many.
            let rc = unsafe {
                (self.sdk.get_string)(
                    c,
                    n.as_ptr(),
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut len,
                    &mut e,
                )
            };
            if rc == RFC_BUFFER_TOO_SMALL && (len as usize) + 1 > buf.len() {
                buf = vec![0; len as usize + 1];
                continue;
            }
            self.check(rc, &e, name)?;
            return Ok(String::from_utf16_lossy(
                &buf[..(len as usize).min(buf.len())],
            ));
        }
    }

    /// One ADT REST request through SADT_REST_RFC_ENDPOINT.
    pub fn rest(
        &self,
        method: &str,
        uri: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<RestResponse, RfcError> {
        let s = &self.sdk;
        let mut e = ErrorInfo::new();
        let fname = uc("SADT_REST_RFC_ENDPOINT");
        // SAFETY: h is live; fname is NUL-terminated.
        let desc = unsafe { (s.desc)(self.h, fname.as_ptr(), &mut e) };
        if desc.is_null() {
            return Err(RfcError::from(&e));
        }
        // SAFETY: desc is a live function description.
        let f = unsafe { (s.create)(desc, &mut e) };
        if f.is_null() {
            return Err(RfcError::from(&e));
        }
        let result = self.rest_call(f, method, uri, headers, body);
        let mut e2 = ErrorInfo::new();
        // SAFETY: f was created above and is destroyed once.
        unsafe { (s.destroy)(f, &mut e2) };
        result
    }

    fn rest_call(
        &self,
        f: Handle,
        method: &str,
        uri: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<RestResponse, RfcError> {
        let s = &self.sdk;
        let req = self.child(s.get_structure, f, "REQUEST")?;
        let line = self.child(s.get_structure, req, "REQUEST_LINE")?;
        self.set(line, "METHOD", method)?;
        self.set(line, "URI", uri)?;
        self.set(line, "VERSION", "HTTP/1.1")?;
        let table = self.child(s.get_table, req, "HEADER_FIELDS")?;
        for (k, v) in headers {
            let mut e = ErrorInfo::new();
            // SAFETY: table is a live table handle.
            let row = unsafe { (s.append_row)(table, &mut e) };
            if row.is_null() {
                return Err(RfcError::from(&e));
            }
            self.set(row, "NAME", k)?;
            self.set(row, "VALUE", v)?;
        }
        let empty = [0u8; 1];
        let ptr = if body.is_empty() {
            empty.as_ptr()
        } else {
            body.as_ptr()
        };
        let mut e = ErrorInfo::new();
        let n = uc("MESSAGE_BODY");
        // SAFETY: ptr points to body.len() bytes (or a 1-byte dummy for an empty body).
        let rc = unsafe { (s.set_xstring)(req, n.as_ptr(), ptr, body.len() as u32, &mut e) };
        self.check(rc, &e, "MESSAGE_BODY")?;

        let mut e = ErrorInfo::new();
        // SAFETY: h and f are live.
        let rc = unsafe { (s.invoke)(self.h, f, &mut e) };
        self.check(rc, &e, "SADT_REST_RFC_ENDPOINT")?;

        let resp = self.child(s.get_structure, f, "RESPONSE")?;
        let status_line = self.child(s.get_structure, resp, "STATUS_LINE")?;
        let status = self
            .get(status_line, "STATUS_CODE")?
            .trim()
            .parse::<u16>()
            .unwrap_or(500);
        let mut out_headers = vec![];
        let table = self.child(s.get_table, resp, "HEADER_FIELDS")?;
        let mut count: u32 = 0;
        let mut e = ErrorInfo::new();
        // SAFETY: table is live.
        let rc = unsafe { (s.row_count)(table, &mut count, &mut e) };
        self.check(rc, &e, "HEADER_FIELDS")?;
        for i in 0..count {
            let mut e = ErrorInfo::new();
            // SAFETY: i < count.
            let rc = unsafe { (s.move_to)(table, i, &mut e) };
            self.check(rc, &e, "HEADER_FIELDS")?;
            // SAFETY: the table is positioned on row i.
            let row = unsafe { (s.current_row)(table, &mut e) };
            if row.is_null() {
                return Err(RfcError::from(&e));
            }
            out_headers.push((
                self.get(row, "NAME")?.trim().to_lowercase(),
                self.get(row, "VALUE")?.trim().to_string(),
            ));
        }
        let n = uc("MESSAGE_BODY");
        let mut len: u32 = 0;
        let mut e = ErrorInfo::new();
        // SAFETY: resp is live.
        let rc = unsafe { (s.get_len)(resp, n.as_ptr(), &mut len, &mut e) };
        self.check(rc, &e, "MESSAGE_BODY")?;
        let mut body = vec![0u8; len as usize + 1];
        let mut got: u32 = 0;
        let mut e = ErrorInfo::new();
        // SAFETY: body has len + 1 bytes.
        let rc = unsafe {
            (s.get_xstring)(
                resp,
                n.as_ptr(),
                body.as_mut_ptr(),
                body.len() as u32,
                &mut got,
                &mut e,
            )
        };
        self.check(rc, &e, "MESSAGE_BODY")?;
        body.truncate(got as usize);
        Ok(RestResponse {
            status,
            headers: out_headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_round_trip() {
        let v = uc("SADT_REST_RFC_ENDPOINT");
        assert_eq!(*v.last().unwrap(), 0);
        assert_eq!(from_uc(&v), "SADT_REST_RFC_ENDPOINT");
    }

    #[test]
    fn error_info_layout_matches_sapnwrfc_h() {
        // two enums, key[128], message[512], class[21], type[2], number[4], 4 x v[51]
        let units = 128 + 512 + 21 + 2 + 4 + 4 * 51;
        assert_eq!(
            std::mem::size_of::<ErrorInfo>(),
            (8 + units * 2 + 3) / 4 * 4
        );
    }

    #[test]
    fn sdk_found_deeper_or_for_another_platform() {
        let base = std::env::temp_dir().join(format!("nusa-rfc-{}", std::process::id()));
        let deep = base.join("nwrfc750P_20").join("nwrfcsdk").join("lib");
        std::fs::create_dir_all(&deep).unwrap();
        let other = if cfg!(windows) {
            "libsapnwrfc.so"
        } else {
            "sapnwrfc.dll"
        };
        std::fs::write(deep.join(other), b"x").unwrap();
        let msg = load(base.to_str().unwrap()).err().unwrap();
        assert!(msg.contains("another operating system"), "{msg}");
        std::fs::write(deep.join(LIB_NAME), b"x").unwrap();
        assert_eq!(
            find_library(base.to_str().unwrap()),
            Some(deep.join(LIB_NAME))
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_sdk_folder_is_reported() {
        assert!(find_library("/definitely/not/here").is_none());
        let msg = load("/definitely/not/here").err().unwrap();
        assert!(msg.contains("does not exist"), "{msg}");
    }
}
