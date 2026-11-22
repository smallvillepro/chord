// @ts-check
/**
 * Plugin manager modal.
 *
 * Self-contained: it does not depend on the app's settings screen, so a broken
 * settings module cannot take the plugin UI down with it. Opens on
 * `Ctrl+Shift+P` or from `Chord.openManager()`.
 */

import { boot, setEnabled, snapshot, subscribe } from "./loader.js";

let overlay = null;
let unsubscribe = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function render(data) {
  if (!overlay) return;
  const list = overlay.querySelector(".plugin-manager__list");
  const pathNode = overlay.querySelector(".plugin-manager__path");
  if (!list || !pathNode) return;
  pathNode.textContent = data.root || "каталог плагинов недоступен";
  list.replaceChildren();

  if (!data.plugins.length) {
    list.appendChild(
      el(
        "div",
        "plugin-empty",
        "Плагинов нет. Положи .js или .css в каталог выше и нажми «Обновить».",
      ),
    );
  }

  for (const plugin of data.plugins) {
    const card = el("div", "plugin-card");
    const main = el("div", "plugin-card__main");
    main.appendChild(el("div", "plugin-card__name", plugin.name));
    const meta = [plugin.description, plugin.authors.length ? plugin.authors.join(", ") : ""]
      .filter(Boolean)
      .join(" · ");
    if (meta) main.appendChild(el("div", "plugin-card__meta", meta));
    if (plugin.file) main.appendChild(el("div", "plugin-card__meta", plugin.file));
    if (plugin.error) main.appendChild(el("div", "plugin-card__error", plugin.error));

    const actions = el("div", "plugin-card__actions");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.enabled;
    toggle.setAttribute("aria-label", `Включить ${plugin.name}`);
    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        await setEnabled(plugin.name, toggle.checked);
      } catch (error) {
        toggle.checked = !toggle.checked;
        window.alert(String(error?.message || error));
      } finally {
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);

    const reload = button("Перезагрузить", "btn btn-secondary", async () => {
      try {
        await boot(true);
      } catch (error) {
        window.alert(String(error?.message || error));
      }
    });
    actions.appendChild(reload);

    card.append(main, actions);
    list.appendChild(card);
  }

  const bootErrors = data.errors.filter((entry) => entry.key.startsWith("__"));
  for (const failure of bootErrors) {
    list.appendChild(el("div", "plugin-card__error", `${failure.key}: ${failure.message}`));
  }
}

function close() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

function open() {
  if (overlay) {
    close();
    return;
  }
  overlay = el("div", "plugin-manager-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Плагины");

  const modal = el("div", "modal-dialog plugin-manager");
  const head = el("div", "plugin-manager__head");
  head.appendChild(el("h2", "modal-title", "Плагины"));
  const controls = el("div", "plugin-manager__head");
  controls.appendChild(
    button("Обновить", "btn btn-secondary", () => {
      boot(true).catch((error) => window.alert(String(error?.message || error)));
    }),
  );
  controls.appendChild(
    button("Открыть папку", "btn btn-secondary", () => {
      import("./loader.js")
        .then((module) => module.openDirectory())
        .catch((error) => window.alert(String(error?.message || error)));
    }),
  );
  controls.appendChild(button("Закрыть", "btn btn-secondary", close));
  head.appendChild(controls);

  const pathNode = el("div", "plugin-manager__path", "…");
  const list = el("div", "plugin-manager__list");

  modal.append(head, pathNode, list);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.body.appendChild(overlay);

  unsubscribe = subscribe(render);
  render(snapshot());
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === "KeyP") {
    event.preventDefault();
    open();
  }
  if (event.key === "Escape" && overlay) close();
});

const globalObject = /** @type {any} */ (window);
globalObject.Chord ??= {};
globalObject.Chord.openManager = open;
