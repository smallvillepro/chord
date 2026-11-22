/**
 * RevealAllSpoilers — при зажатом Ctrl раскрывает все спойлеры в чате.
 *
 * Порт Vencord `revealAllSpoilers`. Там плагин патчил React-рендер спойлера;
 * в Chord разметка уже несёт `data-spoiler="hidden"`, поэтому достаточно
 * переопределить стиль на время удержания клавиши. Состояние приложения не
 * трогается: отпустил Ctrl — спойлеры снова скрыты.
 */
Chord.definePlugin({
  name: "RevealAllSpoilers",
  description: "Показывает все спойлеры, пока зажат Ctrl",
  authors: [{ name: "Vendicated" }],

  start({ injectCSS }) {
    injectCSS(`
      body.chord-reveal-spoilers .md-spoiler[data-spoiler="hidden"] {
        color: var(--text) !important;
        background: var(--surface-sunken) !important;
        user-select: text !important;
        cursor: text !important;
      }
    `);

    const show = (event) => {
      if (event.key === "Control") document.body.classList.add("chord-reveal-spoilers");
    };
    const hide = (event) => {
      if (event.key === "Control") document.body.classList.remove("chord-reveal-spoilers");
    };
    const reset = () => document.body.classList.remove("chord-reveal-spoilers");

    document.addEventListener("keydown", show);
    document.addEventListener("keyup", hide);
    window.addEventListener("blur", reset);
    this._handlers = { show, hide, reset };
  },

  stop() {
    if (!this._handlers) return;
    document.removeEventListener("keydown", this._handlers.show);
    document.removeEventListener("keyup", this._handlers.hide);
    window.removeEventListener("blur", this._handlers.reset);
    document.body.classList.remove("chord-reveal-spoilers");
    delete this._handlers;
  },
});
