// @ts-check
/**
 * Plugin loader.
 *
 * Plugins are ES modules read from `userplugins/` by the Rust side
 * (`plugins_read`) and evaluated through a Blob URL: a data URL would lose the
 * module graph and `new Function` cannot express `export`/`import`.
 *
 * A plugin calls `Chord.definePlugin({...})` at module top level. The loader
 * then runs `start()` once enabled and `stop()` on disable. Sources are plain
 * JS with no build step, so a plugin can be dropped in and reloaded with F5.
 *
 * Failure policy: one broken plugin never blocks the app or the other plugins.
 * Errors are collected and surfaced in the plugin manager.
 */

const STATE_VERSION = 1;
const PLUGIN_TIMEOUT_MS = 10_000;
const MAX_PLUGIN_SIZE = 2 * 1024 * 1024;

/** @typedef {{ name: string, description?: string, authors?: any[], start?: Function, stop?: Function, settings?: any, css?: string, patches?: any[] }} PluginDef */

const registry = new Map();
const enabled = new Set();
const errors = new Map();
const disposers = new Map();
const messageHooks = new Set();
let seenMessages = new WeakSet();
let messageObserver = null;
let state = { version: STATE_VERSION, enabled: {}, settings: {} };
let statePath = "";
let rootPath = "";
let booted = false;
const listeners = new Set();

function invoke(name, args) {
  const tauri = /** @type {any} */ (window).__TAURI__;
  const fn = tauri?.core?.invoke || tauri?.tauri?.invoke;
  if (!fn) throw new Error("Tauri IPC недоступен");
  return fn(name, args);
}

/** Errors from Rust come as `{kind, message, path?, field?}`; never render them raw. */
function ipcMessage(error) {
  if (!error) return "неизвестная ошибка";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function settingsKey(name) {
  return `plugin:${name}`;
}

/** Per-plugin persistent value store backed by `plugins_state_save`. */
class DataStore {
  constructor(pluginName) {
    this.pluginName = pluginName;
  }

  get(key, fallback) {
    const bucket = state.settings[settingsKey(this.pluginName)] || {};
    return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
  }

  set(key, value) {
    const bucket = { ...(state.settings[settingsKey(this.pluginName)] || {}) };
    bucket[key] = value;
    state.settings[settingsKey(this.pluginName)] = bucket;
    return persist();
  }

  delete(key) {
    const bucket = { ...(state.settings[settingsKey(this.pluginName)] || {}) };
    delete bucket[key];
    state.settings[settingsKey(this.pluginName)] = bucket;
    return persist();
  }

  all() {
    return { ...(state.settings[settingsKey(this.pluginName)] || {}) };
  }
}

/** Wraps a function on an object and returns an undo hook. */
class Patcher {
  constructor(target, label = "patch") {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      throw new Error(`Patcher: цель ${label} не является объектом`);
    }
    this.target = target;
    this.label = label;
    this.undo = [];
  }

  /** Runs `replacement` instead of `original`; `this` and arguments are kept. */
  instead(property, replacement) {
    const target = this.target;
    const original = target[property];
    if (typeof original !== "function") {
      throw new Error(`Patcher: ${this.label}.${String(property)} не функция`);
    }
    target[property] = function patched(...args) {
      return replacement.call(this, args, original.bind(this));
    };
    this.undo.push(() => {
      target[property] = original;
    });
    return this;
  }

  /** Runs `callback` before the original. Return value is ignored. */
  before(property, callback) {
    const original = this.target[property];
    if (typeof original !== "function") {
      throw new Error(`Patcher: ${this.label}.${String(property)} не функция`);
    }
    this.target[property] = function patched(...args) {
      callback.call(this, args);
      return original.apply(this, args);
    };
    this.undo.push(() => {
      this.target[property] = original;
    });
    return this;
  }

  /** Runs `callback` after the original and may rewrite its result. */
  after(property, callback) {
    const original = this.target[property];
    if (typeof original !== "function") {
      throw new Error(`Patcher: ${this.label}.${String(property)} не функция`);
    }
    this.target[property] = function patched(...args) {
      const result = original.apply(this, args);
      const next = callback.call(this, args, result);
      return next === undefined ? result : next;
    };
    this.undo.push(() => {
      this.target[property] = original;
    });
    return this;
  }

  unpatchAll() {
    while (this.undo.length) {
      const undo = this.undo.pop();
      try {
        undo();
      } catch (error) {
        console.warn("[plugins] unpatch failed", error);
      }
    }
  }
}

function injectCSS(pluginName, css) {
  if (!css) return () => {};
  const element = document.createElement("style");
  element.dataset.plugin = pluginName;
  element.textContent = css;
  document.head.appendChild(element);
  return () => element.remove();
}

function showToast(message, kind = "info") {  const host = document.getElementById("toast-host") || document.body;
  const toast = document.createElement("div");
  toast.className = `plugin-toast plugin-toast--${kind}`;
  toast.textContent = String(message);
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/** Simple on/off switch description used by the plugin manager. */
function defineSettings(definition) {
  return definition;
}

/**
 * Calls `callback(row, messageId, channelId)` for every rendered message row.
 * Rows are marked with `data-message-id` by `renderChannelMessage`; the loader
 * watches the DOM instead of patching the renderer, so a plugin cannot break
 * the message list, and a re-rendered row is reported again only if the node
 * is new.
 */
function onMessageRender(callback) {
  if (typeof callback !== "function") throw new Error("onMessageRender: нужна функция");
  messageHooks.add(callback);
  ensureMessageObserver();
  for (const row of document.querySelectorAll("[data-message-id]")) {
    reportMessage(row);
  }
  return () => messageHooks.delete(callback);
}

function reportMessage(row) {
  if (!(row instanceof HTMLElement) || seenMessages.has(row)) return;
  seenMessages.add(row);
  const messageId = row.dataset.messageId || "";
  const channelId = row.dataset.channelId || "";
  for (const hook of messageHooks) {
    try {
      hook(row, messageId, channelId);
    } catch (error) {
      console.warn("[plugins] message hook failed", error);
    }
  }
}

function ensureMessageObserver() {
  if (messageObserver) return;
  messageObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches("[data-message-id]")) reportMessage(node);
        for (const row of node.querySelectorAll("[data-message-id]")) reportMessage(row);
      }
    }
  });
  messageObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Subscribes to the raw gateway envelope: `{kind, data}` where `kind` is the
 * Discord event name. Same event the app bridge consumes; plugins get their own
 * listener, so throwing here cannot stall the app.
 */
function onDispatch(callback) {
  if (typeof callback !== "function") throw new Error("onDispatch: нужна функция");
  const tauri = /** @type {any} */ (window).__TAURI__;
  if (!tauri?.event?.listen) return Promise.resolve(() => {});
  return tauri.event.listen("gateway://dispatch", (event) => {
    try {
      callback(event?.payload);
    } catch (error) {
      console.warn("[plugins] dispatch hook failed", error);
    }
  });
}

const api = {
  version: "0.1.0",
  definePlugin,
  defineSettings,
  injectCSS,
  showToast,
  Patcher,
  DataStore,
  onMessageRender,
  onDispatch,
  /** Live app registry published by `app.js` (`window.__CHORD__`). */
  get app() {
    return /** @type {any} */ (window).__CHORD__ || null;
  },
  /** Read-only view for plugins that only render UI. */
  getPlugins: () => Array.from(registry.values()),
  /** Re-run one plugin after editing its source on disk. */
  reloadPlugin: (name) => reloadPlugin(name),
  reloadAll: () => boot(true),
};

/** @param {PluginDef} definition */
function definePlugin(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("definePlugin: ожидается объект");
  }
  if (!definition.name || typeof definition.name !== "string") {
    throw new Error("definePlugin: поле name обязательно");
  }
  if (registry.has(definition.name)) {
    throw new Error(`definePlugin: плагин «${definition.name}» уже зарегистрирован`);
  }
  const record = {
    ...definition,
    authors: Array.isArray(definition.authors) ? definition.authors : [],
    definition,
    active: false,
    source: "",
  };
  registry.set(definition.name, record);
  notify();
  return record;
}

async function persist() {
  try {
    await invoke("plugins_state_save", { state });
  } catch (error) {
    errors.set("__state__", ipcMessage(error));
    notify();
  }
}

async function startPlugin(record) {
  if (record.active) return;
  const pluginName = record.name;
  const cleanups = [];

  try {
    if (record.css) cleanups.push(injectCSS(pluginName, record.css));

    const store = new DataStore(pluginName);
    const patcher = new Patcher(record, pluginName);
    const context = {
      name: pluginName,
      settings: store,
      patcher,
      injectCSS: (css) => cleanups.push(injectCSS(pluginName, css)),
      toast: showToast,
      /** Auto-disposed on stop, unlike the raw `Chord.onMessageRender`. */
      onMessageRender: (callback) => cleanups.push(onMessageRender(callback)),
      /** Auto-disposed on stop; resolves to the Tauri unlisten function. */
      onDispatch: (callback) => {
        let unlisten = null;
        let stopped = false;
        onDispatch(callback).then((off) => {
          if (stopped) off();
          else unlisten = off;
        });
        cleanups.push(() => {
          stopped = true;
          unlisten?.();
        });
      },
      api,
    };

    if (typeof record.start === "function") {
      const result = record.start(context);
      if (result && typeof result.then === "function") {
        await result;
      }
    }
    cleanups.push(() => patcher.unpatchAll());
    disposers.set(pluginName, cleanups);
    record.active = true;
    errors.delete(pluginName);
  } catch (error) {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (cleanupError) {
        console.warn("[plugins] cleanup failed", cleanupError);
      }
    }
    record.active = false;
    errors.set(pluginName, String(error?.stack || error?.message || error));
  }
  notify();
}

async function stopPlugin(record) {
  if (!record.active) return;
  const cleanups = disposers.get(record.name) || [];
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch (error) {
      errors.set(record.name, String(error?.message || error));
    }
  }
  disposers.delete(record.name);
  try {
    if (typeof record.stop === "function") await record.stop();
  } catch (error) {
    errors.set(record.name, String(error?.message || error));
  }
  record.active = false;
  notify();
}

/** Imports one source file and waits up to `PLUGIN_TIMEOUT_MS` for its registration. */
async function importSource(file, source) {
  if (source.length > MAX_PLUGIN_SIZE) {
    throw new Error(`файл больше ${MAX_PLUGIN_SIZE} байт`);
  }
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const before = new Set(registry.keys());
  try {
    await Promise.race([
      import(/* @vite-ignore */ url),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("таймаут загрузки модуля")), PLUGIN_TIMEOUT_MS),
      ),
    ]);
  } finally {
    URL.revokeObjectURL(url);
  }
  const added = Array.from(registry.keys()).filter((name) => !before.has(name));
  if (!added.length) {
    throw new Error("модуль не вызвал Chord.definePlugin");
  }
  return added;
}

async function reloadPlugin(name) {
  const record = registry.get(name);
  if (!record) throw new Error(`плагин «${name}» не загружен`);
  await stopPlugin(record);
  registry.delete(name);
  const source = await invoke("plugins_read", { file: record.file || `${name}.js` });
  await importSource(record.file || `${name}.js`, source);
  const fresh = registry.get(name);
  if (fresh) await startPlugin(fresh);
}

let bootPromise = null;

/**
 * Reads the directory, imports every plugin, starts the enabled ones.
 * Idempotent: repeated calls share one run.
 */
export async function boot(force = false) {
  if (bootPromise && !force) return bootPromise;
  bootPromise = (async () => {
    if (force) {
      for (const record of registry.values()) {
        await stopPlugin(record);
      }
      for (const [key, cleanups] of disposers) {
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup();
          } catch (error) {
            console.warn("[plugins] cleanup failed", error);
          }
        }
        disposers.delete(key);
      }
      registry.clear();
      errors.clear();
      seenMessages = new WeakSet();
    }
    try {
      rootPath = await invoke("plugins_dir");
      state = await invoke("plugins_state_load");
      if (!state || typeof state !== "object") state = { version: STATE_VERSION, enabled: {}, settings: {} };
      state.version = STATE_VERSION;
      state.enabled ||= {};
      state.settings ||= {};
      statePath = rootPath;
    } catch (error) {
      errors.set("__boot__", ipcMessage(error));
      notify();
      return { ok: false, error: ipcMessage(error) };
    }

    let files = [];
    try {
      files = await invoke("plugins_list");
    } catch (error) {
      errors.set("__boot__", ipcMessage(error));
      notify();
      return { ok: false, error: ipcMessage(error) };
    }

    for (const entry of files) {
      if (entry.kind === "css") continue;
      try {
        const source = await invoke("plugins_read", { file: entry.file });
        const names = await importSource(entry.file, source);
        for (const name of names) {
          const record = registry.get(name);
          if (record) record.file = entry.file;
        }
      } catch (error) {
        errors.set(entry.file, String(error?.message || error));
      }
    }

    for (const entry of files) {
      if (entry.kind !== "css") continue;
      try {
        const css = await invoke("plugins_read", { file: entry.file });
        const name = entry.file.replace(/\.css$/i, "");
        if (!registry.has(name)) {
          definePlugin({
            name,
            description: "Стилевой плагин",
            authors: [{ name: "local" }],
            css,
          });
          const record = registry.get(name);
          if (record) record.file = entry.file;
        }
      } catch (error) {
        errors.set(entry.file, String(error?.message || error));
      }
    }

    for (const record of registry.values()) {
      const flag = state.enabled[record.name];
      if (flag) await startPlugin(record);
    }
    booted = true;
    notify();
    return { ok: true, plugins: registry.size, root: rootPath };
  })();
  return bootPromise;
}

/** Opens the plugin directory in the platform file manager. */
export async function openDirectory() {
  const path = await invoke("plugins_open_dir");
  return path;
}

/** Enables or disables a plugin and persists the flag. */
export async function setEnabled(name, value) {
  const record = registry.get(name);
  if (!record) throw new Error(`плагин «${name}» не найден`);
  state.enabled[name] = Boolean(value);
  if (value) await startPlugin(record);
  else await stopPlugin(record);
  await persist();
  notify();
}

/** Current snapshot for the plugin manager UI. */
export function snapshot() {
  return {
    root: rootPath,
    booted,
    plugins: Array.from(registry.values()).map((record) => ({
      name: record.name,
      description: record.description || "",
      authors: (record.authors || []).map((author) => (typeof author === "string" ? author : author?.name || "?")),
      active: Boolean(record.active),
      enabled: Boolean(state.enabled[record.name]),
      file: record.file || "",
      settings: record.settings || null,
      error: errors.get(record.name) || "",
    })),
    errors: Array.from(errors.entries()).map(([key, message]) => ({ key, message })),
  };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  const data = snapshot();
  for (const listener of listeners) {
    try {
      listener(data);
    } catch (error) {
      console.warn("[plugins] listener failed", error);
    }
  }
}

/** Exposed for devtools and for plugins that need the shared instance. */
const globalObject = /** @type {any} */ (window);
globalObject.Chord = api;
globalObject.ChordPlugins = { snapshot, setEnabled, boot, subscribe };

// Manager UI is optional: a missing file must not take the loader down.
import("./manager.js").catch((error) => {
  console.warn("[plugins] manager unavailable", error);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
} else {
  boot();
}
