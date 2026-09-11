// @ts-check
/**
 * Автолейн — общая серийная цепочка для АВТОМАТИЧЕСКОЙ генерации:
 * инлайн-задачи чата + все мостовые вызовы. Один платный POST автоматики
 * за раз; ручная генерация и пачечная очередь живут в своих лейнах как раньше.
 */

let _chain = Promise.resolve();

/**
 * Поставить задачу в автолейн. Задача стартует по завершении предыдущей
 * (независимо от её успеха). Возвращает промис самой задачи.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueAutoLane(fn) {
    const pending = _chain.then(fn, fn);
    _chain = pending.catch(() => {});
    return pending;
}
