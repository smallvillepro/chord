//! Plugin storage for the Chord web UI.
//!
//! The renderer is a WebView with `csp: null` and `withGlobalTauri`, so plugins
//! are plain ES modules loaded from disk at runtime. This module owns the disk
//! side only: where plugins live, which files are exposed, and the persisted
//! enabled/settings state. Nothing here executes plugin code.
//!
//! Root resolution: `DL_PLUGINS_DIR`, then `<exe dir>/userplugins`, then
//! `<cwd>/userplugins`. The exe-relative location is the packaged layout; the
//! cwd fallback covers `cargo run` from the repo.
//!
//! Security boundaries:
//! - only `.js`, `.mjs`, `.css` files directly inside the root are listed;
//! - names are validated as single path components before any read;
//! - reads are capped at [`MAX_PLUGIN_BYTES`] and must be UTF-8.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Environment override for the plugin directory.
pub const PLUGINS_DIR_ENV: &str = "DL_PLUGINS_DIR";
/// Environment override for the state file (mirrors `DL_SETTINGS_PATH`).
pub const PLUGINS_STATE_ENV: &str = "DL_PLUGINS_STATE_PATH";
/// Hard cap on a single plugin source file. Larger files are refused, not truncated.
pub const MAX_PLUGIN_BYTES: u64 = 2 * 1024 * 1024;
/// Hard cap on the persisted state file.
pub const MAX_STATE_BYTES: u64 = 1024 * 1024;
/// Directory created next to the binary on first run.
pub const DEFAULT_DIR: &str = "userplugins";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// One plugin file as seen by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    /// File name, including extension. Also the plugin key.
    pub file: String,
    /// Extension without the dot: `js`, `mjs` or `css`.
    pub kind: String,
    /// Size in bytes.
    pub bytes: u64,
    /// Last modification time, Unix milliseconds.
    pub modified_ms: u64,
}

/// Persisted plugin state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginState {
    /// Schema version; only `1` is accepted.
    pub version: u32,
    /// Enabled flag per plugin file.
    #[serde(default)]
    pub enabled: BTreeMap<String, bool>,
    /// Free-form per-plugin settings, owned by the plugin itself.
    #[serde(default)]
    pub settings: BTreeMap<String, serde_json::Value>,
}

impl Default for PluginState {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: BTreeMap::new(),
            settings: BTreeMap::new(),
        }
    }
}

/// Error surface for the plugin IPC commands.
#[derive(Debug)]
pub enum PluginError {
    /// Filesystem failure with the path that failed.
    Io { path: PathBuf, message: String },
    /// Bad plugin name or unsupported extension.
    Invalid { field: String, message: String },
    /// File is not UTF-8 or exceeds the size cap.
    Parse { path: PathBuf, message: String },
    /// Blocking task failed to join; never caused by plugin content.
    Internal { message: String },
}

impl PluginError {
    /// Stable discriminator for the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            PluginError::Io { .. } => "Io",
            PluginError::Invalid { .. } => "Invalid",
            PluginError::Parse { .. } => "Parse",
            PluginError::Internal { .. } => "Internal",
        }
    }

    fn message(&self) -> &str {
        match self {
            PluginError::Io { message, .. }
            | PluginError::Invalid { message, .. }
            | PluginError::Parse { message, .. }
            | PluginError::Internal { message } => message,
        }
    }

    /// Wraps a task-join failure; not reachable from plugin content.
    pub fn internal(message: impl Into<String>) -> Self {
        PluginError::Internal {
            message: message.into(),
        }
    }

    fn io(path: &Path, message: impl Into<String>) -> Self {
        PluginError::Io {
            path: path.to_path_buf(),
            message: message.into(),
        }
    }

    fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {
        PluginError::Invalid {
            field: field.into(),
            message: message.into(),
        }
    }

    fn parse(path: &Path, message: impl Into<String>) -> Self {
        PluginError::Parse {
            path: path.to_path_buf(),
            message: message.into(),
        }
    }
}

impl fmt::Display for PluginError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PluginError::Io { path, message } => {
                write!(formatter, "Io ({}): {message}", path.display())
            }
            PluginError::Invalid { field, message } => {
                write!(formatter, "Invalid [{field}]: {message}")
            }
            PluginError::Parse { path, message } => {
                write!(formatter, "Parse ({}): {message}", path.display())
            }
            PluginError::Internal { message } => write!(formatter, "Internal: {message}"),
        }
    }
}

impl std::error::Error for PluginError {}

/// Serialized shape for the frontend: `kind`/`message` plus the failing path or field.
#[derive(Serialize)]
struct ErrorView<'a> {
    kind: &'static str,
    message: &'a str,
    path: Option<String>,
    field: Option<&'a str>,
}

impl Serialize for PluginError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let view = ErrorView {
            kind: self.kind(),
            message: self.message(),
            path: match self {
                PluginError::Io { path, .. } | PluginError::Parse { path, .. } => {
                    Some(path.display().to_string())
                }
                PluginError::Invalid { .. } | PluginError::Internal { .. } => None,
            },
            field: match self {
                PluginError::Invalid { field, .. } => Some(field.as_str()),
                _ => None,
            },
        };
        view.serialize(serializer)
    }
}

/// Plugin directory resolved from the environment, else next to the binary.
pub fn plugins_dir() -> PathBuf {
    if let Ok(value) = std::env::var(PLUGINS_DIR_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join(DEFAULT_DIR);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(DEFAULT_DIR)
}

/// State file path: `DL_PLUGINS_STATE_PATH`, else `plugins-state.json` inside the plugin dir.
pub fn state_path() -> PathBuf {
    if let Ok(value) = std::env::var(PLUGINS_STATE_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    plugins_dir().join("plugins-state.json")
}

/// Accepts `name.js` only: no separators, no drive prefix, allowed extension.
/// The name must already be exact: leading or trailing whitespace is rejected
/// instead of trimmed, because `list_in` reports raw file names and a trimmed
/// read would resolve to a different file.
fn validate_name(name: &str) -> Result<&str, PluginError> {
    if name.is_empty() {
        return Err(PluginError::invalid(
            "file",
            "имя плагина не может быть пустым",
        ));
    }
    if name.len() > 128 {
        return Err(PluginError::invalid(
            "file",
            "имя плагина длиннее 128 символов",
        ));
    }
    if name != name.trim() {
        return Err(PluginError::invalid(
            "file",
            "имя плагина не должно начинаться или заканчиваться пробелом",
        ));
    }
    if name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
        || name.contains('\0')
    {
        return Err(PluginError::invalid(
            "file",
            "имя плагина должно быть простым именем файла без разделителей, диска и ..",
        ));
    }
    let lower = name.to_ascii_lowercase();
    let ok = lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".css");
    if !ok {
        return Err(PluginError::invalid(
            "file",
            "поддерживаются только .js, .mjs и .css",
        ));
    }
    Ok(name)
}

fn kind_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mjs") {
        "mjs"
    } else if lower.ends_with(".css") {
        "css"
    } else {
        "js"
    }
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

/// Lists plugin files directly inside `root`. A missing directory is an empty
/// list: a fresh install has no plugins yet, that is not an error.
pub fn list_in(root: &Path) -> Result<Vec<PluginEntry>, PluginError> {
    let read_dir = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(PluginError::io(
                root,
                format!("не удалось прочитать каталог плагинов: {error}"),
            ))
        }
    };

    let mut entries = Vec::new();
    for item in read_dir {
        let item = item.map_err(|error| {
            PluginError::io(
                root,
                format!("не удалось прочитать элемент каталога: {error}"),
            )
        })?;
        let path = item.path();
        let metadata = match item.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(file) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if validate_name(file).is_err() {
            continue;
        }
        if metadata.len() > MAX_PLUGIN_BYTES {
            continue;
        }
        entries.push(PluginEntry {
            file: file.to_string(),
            kind: kind_of(file).to_string(),
            bytes: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }
    entries.sort_by(|left, right| {
        left.file
            .to_ascii_lowercase()
            .cmp(&right.file.to_ascii_lowercase())
    });
    Ok(entries)
}

/// Lists plugins in the configured directory.
pub fn list() -> Result<Vec<PluginEntry>, PluginError> {
    list_in(&plugins_dir())
}

/// Reads one plugin source as UTF-8. Refuses oversized files instead of
/// truncating: a truncated module would fail in a confusing place later.
pub fn read_in(root: &Path, name: &str) -> Result<String, PluginError> {
    let name = validate_name(name)?;
    let path = root.join(name);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| PluginError::io(&path, format!("плагин недоступен: {error}")))?;
    if !metadata.is_file() {
        return Err(PluginError::invalid("file", "плагин должен быть файлом"));
    }
    if metadata.len() > MAX_PLUGIN_BYTES {
        return Err(PluginError::parse(
            &path,
            format!("файл больше {MAX_PLUGIN_BYTES} байт"),
        ));
    }
    let bytes =
        std::fs::read(&path).map_err(|error| PluginError::io(&path, format!("чтение: {error}")))?;
    String::from_utf8(bytes)
        .map_err(|_| PluginError::parse(&path, "файл не является корректным UTF-8"))
}

/// Reads a plugin from the configured directory.
pub fn read(name: &str) -> Result<String, PluginError> {
    read_in(&plugins_dir(), name)
}

/// Loads state; a missing file yields defaults.
pub fn load_state_from(path: &Path) -> Result<PluginState, PluginError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginState::default())
        }
        Err(error) => {
            return Err(PluginError::io(
                path,
                format!("состояние плагинов недоступно: {error}"),
            ))
        }
    };
    if metadata.len() > MAX_STATE_BYTES {
        return Err(PluginError::parse(
            path,
            format!("файл состояния больше {MAX_STATE_BYTES} байт"),
        ));
    }
    let bytes =
        std::fs::read(path).map_err(|error| PluginError::io(path, format!("чтение: {error}")))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| PluginError::parse(path, "файл состояния не является UTF-8"))?;
    let state: PluginState = serde_json::from_str(&text)
        .map_err(|error| PluginError::parse(path, format!("некорректный JSON: {error}")))?;
    if state.version != 1 {
        return Err(PluginError::invalid(
            "version",
            format!(
                "поддерживается только version=1, получено {}",
                state.version
            ),
        ));
    }
    Ok(state)
}

/// Loads state from the configured path.
pub fn load_state() -> Result<PluginState, PluginError> {
    load_state_from(&state_path())
}

/// Atomic write: temp file in the same directory, fsync, rename.
pub fn save_state_to(path: &Path, state: &PluginState) -> Result<(), PluginError> {
    if state.version != 1 {
        return Err(PluginError::invalid(
            "version",
            "version должен быть равен 1",
        ));
    }
    let serialized = serde_json::to_vec_pretty(state)
        .map_err(|error| PluginError::invalid("state", format!("сериализация: {error}")))?;
    if serialized.len() as u64 > MAX_STATE_BYTES {
        return Err(PluginError::invalid(
            "state",
            format!("состояние больше {MAX_STATE_BYTES} байт"),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            PluginError::io(parent, format!("не удалось создать каталог: {error}"))
        })?;
    }
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{counter}", std::process::id()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|error| {
            PluginError::io(&tmp, format!("создание временного файла: {error}"))
        })?;
        file.write_all(&serialized)
            .map_err(|error| PluginError::io(&tmp, format!("запись: {error}")))?;
        file.sync_all()
            .map_err(|error| PluginError::io(&tmp, format!("sync: {error}")))?;
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(PluginError::io(path, format!("переименование: {error}")));
    }
    Ok(())
}

/// Saves state to the configured path.
pub fn save_state(state: &PluginState) -> Result<(), PluginError> {
    save_state_to(&state_path(), state)
}

/// Creates the plugin directory so the UI can open it on a fresh install.
pub fn ensure_dir() -> Result<PathBuf, PluginError> {
    let root = plugins_dir();
    std::fs::create_dir_all(&root)
        .map_err(|error| PluginError::io(&root, format!("не удалось создать каталог: {error}")))?;
    Ok(root)
}

/// Opens the plugin directory in the platform file manager.
///
/// User-initiated only: the UI calls this from the manager button. The path is
/// resolved here, never taken from the renderer.
pub fn open_dir() -> Result<PathBuf, PluginError> {
    let root = ensure_dir()?;
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(&root);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(&root);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&root);
        command
    };
    command
        .spawn()
        .map_err(|error| PluginError::io(&root, format!("не удалось открыть каталог: {error}")))?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "chord-plugins-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn rejects_traversal_and_foreign_extensions() {
        for name in [
            "../evil.js",
            "sub/evil.js",
            "sub\\evil.js",
            "..",
            "evil.exe",
            "",
            "C:evil.js",
            "C:\\evil.js",
            " evil.js",
            "evil.js ",
            "ev\0il.js",
        ] {
            assert!(validate_name(name).is_err(), "{name} must be rejected");
        }
        for name in ["acme.js", "acme.mjs", "acme.css"] {
            assert!(validate_name(name).is_ok(), "{name} must be accepted");
        }
    }

    #[test]
    fn list_ignores_directories_and_foreign_files() {
        let root = temp_dir("list");
        std::fs::write(root.join("ok.js"), "Chord.definePlugin({name:'x'})").unwrap();
        std::fs::write(root.join("skip.exe"), "MZ").unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();

        let entries = list_in(&root).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file, "ok.js");
        assert_eq!(entries[0].kind, "js");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_directory_is_empty_not_an_error() {
        let root = std::env::temp_dir().join("chord-plugins-does-not-exist");
        let entries = list_in(&root).expect("missing dir is fine");
        assert!(entries.is_empty());
    }

    #[test]
    fn read_refuses_names_outside_root() {
        let root = temp_dir("read");
        std::fs::write(root.join("ok.js"), "export {};").unwrap();

        let text = read_in(&root, "ok.js").expect("read");
        assert_eq!(text, "export {};");
        assert!(read_in(&root, "../ok.js").is_err());
        assert!(read_in(&root, "nope.js").is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn state_round_trip_is_atomic_and_bounded() {
        let root = temp_dir("state");
        let path = root.join("plugins-state.json");
        let mut state = PluginState::default();
        state.enabled.insert("acme.js".into(), true);
        state.settings.insert(
            "plugin:acme.js".into(),
            serde_json::json!({"color": "#fff"}),
        );

        save_state_to(&path, &state).expect("save");
        let loaded = load_state_from(&path).expect("load");
        assert_eq!(loaded, state);

        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file must be renamed away");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn state_rejects_unknown_version() {
        let root = temp_dir("version");
        let path = root.join("plugins-state.json");
        std::fs::write(&path, r#"{"version":2,"enabled":{},"settings":{}}"#).unwrap();
        assert!(load_state_from(&path).is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
