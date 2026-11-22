# Plugin system (web UI)

Status: proof of concept on top of `rust/gui-spike` (the Tauri + WebView2 client).
Scope: the web UI only. `discord-gpui` is a native Rust renderer and has no
JavaScript runtime, so it is out of scope for this design.

## Why

The Tauri spike ships `security.csp: null` and `withGlobalTauri: true`, which
makes the renderer a normal ES-module environment. Plugins therefore need no
build step, no bundler and no patching of the binary: a `.js` file dropped into
a directory is imported at startup.

## Layout

```
core:   rust/gui-spike/src/plugins_store.rs    disk: list, read, state, limits
        rust/gui-spike/src/plugins_plugin.rs   Tauri module wrapper, spawn_blocking
        rust/gui-spike/ui/plugins/loader.js    module registry, API, lifecycle
        rust/gui-spike/ui/plugins/manager.js   Ctrl+Shift+P modal
        rust/gui-spike/ui/plugins/plugins.css  toast + manager styles
user:   <exe dir>/userplugins/*.js | *.mjs | *.css
        <exe dir>/userplugins/plugins-state.json
```

The directory can be moved with `DL_PLUGINS_DIR`; the state file with
`DL_PLUGINS_STATE_PATH`. Both follow the existing `DL_SETTINGS_PATH` convention.

## Contract

A plugin is an ES module that calls `Chord.definePlugin(def)` at top level:

```js
Chord.definePlugin({
  name: "Example",
  description: "…",
  authors: [{ name: "…" }],
  start({ settings, patcher, injectCSS, toast }) {},
  stop() {},
});
```

`start` may return a promise; the loader awaits it. `stop` runs on disable and
on reload. Everything registered through `context` (`injectCSS`, `patcher`) is
disposed automatically even if `stop` throws.

| API | Notes |
|---|---|
| `Chord.onMessageRender(cb)` | `cb(row, messageId, channelId)`; DOM observer, nothing is patched |
| `Chord.onDispatch(cb)` | raw `gateway://dispatch` payload `{kind, data}` |
| `Chord.Patcher` | `before` / `instead` / `after` on an object property, returns undo |
| `Chord.injectCSS(css)` | returns a remover |
| `Chord.DataStore` | per-plugin persistent JSON, saved through `plugins_state_save` |
| `Chord.app` | live registry published by `app.js` (`window.__CHORD__`) |

`app.js` publishes `window.__CHORD__` right before `boot()` returns: `invoke`,
`dispatch`, `chat`, `composer`, `tree`, `members`, `rail`, `voice`, `settings`,
`notifications`, `renderMessage`, `app` getter and `listen`. ES-module bindings
cannot be monkey-patched from outside, so this object is the supported surface;
modules can still be patched through it because they are objects.

## Isolation and failure handling

- Plugins are trusted code: they run in the renderer with the same privileges as
  the app. This is a local feature, not a marketplace.
- One plugin cannot take the app down: import, `start` and `stop` are wrapped;
  errors land in the manager and in the console, other plugins keep running.
- Import timeout: 10 s. Source cap: 2 MiB per file, 1 MiB for state. Names are
  validated as single path components, so `../`, `C:` and subdirectories are
  rejected. Files above the cap are skipped by `plugins_list` and refused by
  `plugins_read`; both are documented limits, not silent truncation.
- State writes are atomic: temp file in the same directory, `sync_all`, rename.
- Nothing is fetched from the network by the loader.

Known limits:

- Symlinks inside the plugin directory are followed. The directory is
  user-controlled and plugins are trusted code, so this only matters if another
  local user can write there.
- A file can change between `plugins_list` and `plugins_read`. The read
  re-checks size, but this is not a hard guarantee against a local attacker.
- Concurrent state writes from two app instances can lose one update; the file
  itself is never left half-written.

## Deliberate non-goals

- **Vencord compatibility.** Vencord plugins patch Discord's webpack modules by
  source string (`patches: [{ find, replacement }]`) and import React/Flux
  stores. Chord has neither, so those plugins cannot run unmodified. The API is
  shaped so that the portable subset (DOM/CSS/event-driven plugins) ports with
  small edits; a port of, for example, `NoMiddleClickPaste` is a copy plus the
  global `Chord.definePlugin` call.
- **A settings UI framework.** Plugins get a key/value store, not a declarative
  settings schema. The manager renders enable/disable and errors only.
- **Sandboxing.** A worker/iframe boundary would break the DOM and event access
  that makes the API useful. Trust is the model.

## Build

```text
cargo build --release -p chord-client
```

`tauri.conf.json` keeps `frontendDist: "ui"`, so the UI ships as-is and no
frontend build step is involved. Copy `ui/plugins/examples/*.js` into
`<exe dir>/userplugins/` to try the bundled examples.

## Tests

`plugins_store` carries unit tests for the boundaries that matter: path
traversal, extension allowlist, missing directory, size/UTF-8 refusal, atomic
state round-trip and version rejection.
