/**
 * NoMiddleClickPaste — отключает вставку по средней кнопке мыши (X11 primary selection).
 *
 * Порт Vencord `noMiddleClickPaste` (src/plugins/noMiddleClickPaste/index.ts),
 * один в один: тот же `mouseup`-перехват, тот же `button === 1`.
 * В Chord нет webpack-импортов, поэтому `IS_LINUX` берётся из user agent,
 * а `definePlugin` — глобальный.
 */
const IS_LINUX = navigator.userAgent.includes("Linux");

function preventMiddleClick(event) {
  if (event.button === 1) {
    event.preventDefault();
  }
}

Chord.definePlugin({
  name: "NoMiddleClickPaste",
  description: "Отключает вставку средней кнопкой мыши — только Linux",
  authors: [{ name: "Darxoon" }],

  start() {
    if (!IS_LINUX) return;
    window.addEventListener("mouseup", preventMiddleClick);
  },

  stop() {
    window.removeEventListener("mouseup", preventMiddleClick);
  },
});
