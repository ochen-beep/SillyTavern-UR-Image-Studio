// @ts-check
/**
 * Автолейн — общая серийная цепочка для АВТОМАТИЧЕСКОЙ генерации:
 * инлайн-задачи чата + все мостовые вызовы. Один платный POST автоматики
 * за раз; ручная генерация и пачечная очередь живут в своих лейнах как раньше.
 */
import { serialize } from './serialize.js';

const AUTOLANE_KEY = 'uris-autolane';

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
