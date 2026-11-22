/**
 * Message time — full timestamp in the tooltip.
 *
 * Demonstrates `Chord.onMessageRender`: the renderer already emits
 * `<time class="timestamp" datetime="ISO">`, so the plugin only enriches it.
 * No DOM structure is assumed beyond that contract.
 *
 * Plugin API used: definePlugin, onMessageRender, DataStore.
 */
Chord.definePlugin({
  name: "MessageTime",
  description: "Полная дата и ISO-время сообщения в tooltip",
  authors: [{ name: "chord-plugins" }],

  start({ settings, onMessageRender }) {
    const format = settings.get("format", "full");
    onMessageRender((row) => {
      if (row.dataset.pluginTime === "1") return;
      const stamp = row.querySelector("time.timestamp");
      if (!stamp) return;
      const iso = stamp.getAttribute("datetime") || "";
      const date = iso ? new Date(iso) : null;
      if (!date || Number.isNaN(date.getTime())) return;

      stamp.title =
        format === "iso"
          ? date.toISOString()
          : date.toLocaleString("ru-RU", {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
      row.dataset.pluginTime = "1";
    });
  },

  stop() {
    for (const row of document.querySelectorAll("[data-plugin-time]")) {
      delete row.dataset.pluginTime;
      row.querySelector("time.timestamp")?.removeAttribute("title");
    }
  },
});
