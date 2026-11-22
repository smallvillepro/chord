# Плагины Chord

Плагин — обычный ES-модуль (`.js`/`.mjs`) или стилевой файл (`.css`),
положенный в каталог `userplugins` рядом с `chord-client.exe`.

Каталог создаётся при первом открытии менеджера плагинов
(`Ctrl+Shift+P`). Переопределить путь можно переменной `DL_PLUGINS_DIR`.

## Структура

```js
Chord.definePlugin({
  name: "MyPlugin",           // уникальный ключ
  description: "Что делает",
  authors: [{ name: "you" }],

  start({ settings, patcher, injectCSS, toast }) {
    // включение плагина
  },

  stop() {
    // выключение: loader сам снимает CSS и патчи, зарегистрированные через context
  },
});
```

## Что даёт API

| Метод | Назначение |
|---|---|
| `Chord.definePlugin(def)` | регистрация плагина |
| `Chord.onMessageRender(cb)` | `cb(row, messageId, channelId)` на каждую отрисованную строку |
| `Chord.onDispatch(cb)` | сырой gateway-конверт `{kind, data}` |
| `Chord.Patcher` | `before` / `instead` / `after` для методов объектов |
| `Chord.injectCSS(css)` | добавить стиль, вернуть функцию снятия |
| `Chord.DataStore` | персистентные настройки плагина |
| `Chord.app` | живой реестр приложения (`window.__CHORD__`) |
| `Chord.showToast(text)` | уведомление |

## Отладка

`F12` в окне клиента открывает devtools WebView2. В консоли:

```js
ChordPlugins.snapshot()      // список, состояние, ошибки
ChordPlugins.setEnabled("MyPlugin", true)
ChordPlugins.boot(true)      // перечитать каталог
```

Ошибка одного плагина не роняет приложение: она видна в менеджере
и в консоли, остальные плагины продолжают работать.
