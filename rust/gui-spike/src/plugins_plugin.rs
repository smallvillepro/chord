//! Modular Tauri v2 plugin (`plugins`) encapsulating the plugin loader IPC.
//!
//! The renderer executes plugin sources; this module only moves bytes:
//! directory resolution, listing, reading and persisted enabled/settings state.
//! All blocking work runs on `spawn_blocking`, same as `settings_plugin`.

use chord_client::plugins_store::{self, PluginEntry, PluginError, PluginState};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| format!("блокирующая операция не завершилась: {error}"))
}

/// Absolute plugin directory, created on demand.
pub async fn plugins_dir() -> Result<String, PluginError> {
    blocking(|| plugins_store::ensure_dir().map(|path| path.display().to_string()))
        .await
        .map_err(PluginError::internal)?
}

/// Opens the plugin directory in Explorer/Finder/file manager.
pub async fn plugins_open_dir() -> Result<String, PluginError> {
    blocking(|| plugins_store::open_dir().map(|path| path.display().to_string()))
        .await
        .map_err(PluginError::internal)?
}

/// Plugin files currently in the directory.
pub async fn plugins_list() -> Result<Vec<PluginEntry>, PluginError> {
    blocking(plugins_store::list)
        .await
        .map_err(PluginError::internal)?
}

/// Source of one plugin, name validated and capped at `MAX_PLUGIN_BYTES`.
pub async fn plugins_read(file: String) -> Result<String, PluginError> {
    blocking(move || plugins_store::read(&file))
        .await
        .map_err(PluginError::internal)?
}

/// Persisted state; a missing file yields defaults.
pub async fn plugins_state_load() -> Result<PluginState, PluginError> {
    blocking(plugins_store::load_state)
        .await
        .map_err(PluginError::internal)?
}

/// Atomic state write.
pub async fn plugins_state_save(state: PluginState) -> Result<(), PluginError> {
    blocking(move || plugins_store::save_state(&state))
        .await
        .map_err(PluginError::internal)?
}

/// Initializes the modular Tauri v2 `"plugins"` plugin.
#[must_use]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("plugins").build()
}
