/**
 * AlwaysAnimate — не даёт клиенту останавливать GIF и анимации.
 *
 * Порт Vencord `alwaysAnimate`, но без webpack-патча: в Chord анимации
 * управляются флагом в состоянии вложения, поэтому плагин снимает `paused`
 * с уже отрисованных медиа и наблюдает за новыми узлами.
 */
Chord.definePlugin({
  name: "AlwaysAnimate",
  description: "Всегда проигрывать GIF и анимированные аватары",
  authors: [{ name: "Vendicated" }],

  start() {
    const resume = (root) => {
      for (const media of root.querySelectorAll?.("img, video") || []) {
        if (media.dataset.chordPaused === "1") continue;
        if (media.tagName === "VIDEO") {
          media.autoplay = true;
          if (media.paused) media.play().catch(() => {});
        }
      }
    };

    resume(document);
    this._observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) resume(node);
        }
      }
    });
    this._observer.observe(document.body, { childList: true, subtree: true });
  },

  stop() {
    this._observer?.disconnect();
    delete this._observer;
  },
});
