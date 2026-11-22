/**
 * NoTypingAnimation — без анимации текста «печатает…».
 *
 * Порт Vencord `noTypingAnimation`. Там плагин выключал CSS-анимацию
 * `dotCycle`; в Chord индикатор не анимирован покадрово, поэтому плагин
 * гасит плавный переход появления, оставляя сам статус.
 */
Chord.definePlugin({
  name: "NoTypingAnimation",
  description: "Отключает плавную анимацию индикатора «печатает…»",
  authors: [{ name: "Vendicated" }],

  start({ injectCSS }) {
    injectCSS(`
      .typing-indicator {
        transition: none !important;
      }
      .typing-indicator[data-visible="true"] {
        animation: none !important;
      }
    `);
  },
});
