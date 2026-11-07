// @ts-check
/**
 * Автолейн — общая серийная цепочка для АВТОМАТИЧЕСКОЙ генерации:
 * инлайн-задачи чата + все мостовые вызовы. Один платный POST автоматики
 * за раз; ручная генерация и пачечная очередь живут в своих лейнах как раньше.
 * Мостовой buildPrompt (платный text-LLM) живёт в соседнем текстовом лейне —
 * отдельный ключ, та же серийность: текст не должен ждать за минутными
 * image-генерациями.
 */
import { serialize } from './serialize.js';

const AUTOLANE_KEY = 'uris-autolane';
const BRIDGE_TEXT_LANE_KEY = 'uris-bridge-textlane';

/**
 * Поставить задачу в автолейн. Задача стартует по завершении предыдущей
 * (независимо от её успеха). Возвращает промис самой задачи.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueAutoLane(fn) {
    return serialize(AUTOLANE_KEY, fn);
}

/**
 * Поставить задачу в текстовый лейн моста. Семантика та же, что у
 * enqueueAutoLane, но ключ свой: N параллельных внешних buildPrompt бьют
 * text-LLM провайдера по одному и не пересекаются с очередью картинок.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueBridgeTextLane(fn) {
    return serialize(BRIDGE_TEXT_LANE_KEY, fn);
}
