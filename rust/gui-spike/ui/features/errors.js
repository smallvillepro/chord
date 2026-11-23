// @ts-check
/// <reference lib="dom" />
/**
 * Типизированные ошибки UI и их видимое представление.
 *
 * Правило волны: ошибка не глотается молча — либо последствие (видимое состояние
 * `.error-state`, счётчик, сообщение), либо явный комментарий best-effort.
 * `console.error` допустим только в этом модуле: штатный сценарий (DOM-тест)
 * обязан проходить с пустыми `consoleErrors`.
 */

/** Коды ошибок: стабильные строки для логов/AT-SPI, не для перевода. */
export const UI_ERRORS = Object.freeze({
  SCREEN_UNKNOWN: "SCREEN_UNKNOWN",
  SCREEN_MISSING: "SCREEN_MISSING",
  ELEMENT_MISSING: "ELEMENT_MISSING",
  WINDOW_EMPTY: "WINDOW_EMPTY",
  RANGE_FAILED: "RANGE_FAILED",
  IPC_FAILED: "IPC_FAILED",
  ACTION_FAILED: "ACTION_FAILED",
  HEIGHTS_INVALID: "HEIGHTS_INVALID",
});

export class UIError extends Error {
  /**
   * @param {string} code один из `UI_ERRORS`
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = "UIError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Человекочитаемое описание любого исключения.
 *
 * `String(object)` даёт "[object Object]", поэтому объекты разбираются по
 * полям: сначала `message`, затем `kind` (Rust-ошибки приходят как
 * `{kind, message, path}`), затем JSON, и только в конце — `toString`.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = /** @type {Record<string, unknown>} */ (error);
    const message = typeof record.message === "string" ? record.message : "";
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (message) return kind ? `${kind}: ${message}` : message;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      // Циклическая структура: падать из-за форматирования ошибки нельзя.
    }
    return Object.prototype.toString.call(error);
  }
  return String(error);
}

/**
 * Приводит любое исключение к `UIError`, сохраняя исходную причину.
 * @param {string} code
 * @param {unknown} error
 * @returns {UIError}
 */
export function asUIError(code, error) {
  if (error instanceof UIError) return error;
  return new UIError(code, describeError(error), error);
}

/**
 * Логирует ошибку один раз и возвращает её. Вызывающий решает, какое состояние
 * показать (разные экраны — разные контейнеры).
 * @param {string} code
 * @param {unknown} error
 * @returns {UIError}
 */
export function reportError(code, error) {
  const uiError = asUIError(code, error);
  console.error(`[${uiError.code}] ${uiError.message}`);
  return uiError;
}

/**
 * Видимое состояние ошибки внутри `container` (не внутри списка: `#chat-list`
 * и `#member-list` держат ровно один sizer). Повторный вызов заменяет прошлое.
 * G2-02: recoverable-ошибку можно закрыть (кнопка с доступным именем), а не
 * только перезапустить приложение; `clearErrorState` вызывается и по успеху.
 * @param {HTMLElement | null} container
 * @param {UIError} error
 * @param {string} [hint]
 */
export function showErrorState(container, error, hint = "Повторите действие или перезапустите спайк") {
  if (!container) return;
  clearErrorState(container);
  const state = document.createElement("div");
  state.className = "error-state";
  state.setAttribute("role", "alert");
  state.setAttribute("data-state", "error");
  state.setAttribute("data-error-code", error.code);
  const title = document.createElement("p");
  title.className = "error-state-title";
  title.textContent = `Ошибка: ${error.message}`;
  const note = document.createElement("p");
  note.className = "error-state-hint";
  note.textContent = hint;
  const close = document.createElement("button");
  close.className = "error-state-close";
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", "Закрыть сообщение об ошибке");
  close.textContent = "✕";
  close.addEventListener("click", () => clearErrorState(container));
  state.append(title, note, close);
  container.appendChild(state);
}

/**
 * @param {HTMLElement | null} container
 */
export function clearErrorState(container) {
  if (!container) return;
  for (const node of container.querySelectorAll(".error-state")) node.remove();
}
