// @ts-check
import { gzipSync, zstdCompressSync } from 'node:zlib';
/**
 * Общий хелпер для тестов провайдеров: мокает globalThis.fetch так, чтобы
 * запросы через CORS-прокси (/proxy/<encoded>) прозрачно декодировались
 * обратно в исходный URL, и handler знал, шёл ли запрос напрямую или через прокси.
 *
 * Контракт mockFetch(handler):
 *   handler(url, options, viaProxy) → { ok, status, json?, text?, blob? } | throws
 *   url — исходный URL (декодированный, без /proxy/ префикса).
 *   viaProxy — true если запрос шёл через /proxy/, false если напрямую.
 *   Если handler не передан — возвращается 200 OK с пустым телом.
 *   handler может бросить — это смоделирует сетевую/CORS ошибку.
 */

/**
 * Установить мок fetch для текущего теста.
 * @param {(url: string, options: object, viaProxy: boolean) => object|Promise<object>} [handler]
 * @returns {() => void} restoreFn — восстанавливает оригинальный fetch
 */
export function mockFetch(handler) {
    const original = globalThis.fetch;
    const wrapped = async (url, options) => {
        // Декодируем /proxy/<encoded> → исходный URL.
        let realUrl = url;
        let viaProxy = false;
        const proxyPrefix = '/proxy/';
        if (typeof url === 'string' && url.startsWith(proxyPrefix)) {
            realUrl = decodeURIComponent(url.slice(proxyPrefix.length));
            viaProxy = true;
        }
        const resp = handler
            ? await handler(realUrl, options, viaProxy)
            : { ok: true, status: 200 };
        // Дефолтные методы ответа, чтобы избежать TypeError в провайдерах.
        // Если text не задан, но задан json — text по умолчанию возвращает JSON-строку
        // (реалистично для API-ответов; провайдеры теперь читают text перед JSON.parse).
        const jsonFn = resp.json ?? (async () => ({}));
        const textFn = resp.text ?? (async () => JSON.stringify(await jsonFn()));
        const arrayBufferFn = resp.arrayBuffer ?? (async () => {
            const t = await textFn();
            return new TextEncoder().encode(t).buffer;
        });
        return {
            ok: resp.ok ?? true,
            status: resp.status ?? 200,
            headers: resp.headers ?? { get: () => '' },
            json: jsonFn,
            text: textFn,
            blob: resp.blob ?? (async () => ({ type: 'image/png', size: 0 })),
            arrayBuffer: arrayBufferFn,
        };
    };
    globalThis.fetch = wrapped;
    return () => { globalThis.fetch = original; };
}

/**
 * Стандартный мок SillyTavern-окружения для провайдер-тестов.
 * Устанавливает в globalThis заглушки SillyTavern, toastr, window, FileReader.
 */
export function installStGlobals() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
        }),
        libs: { localforage: { getItem: () => '', setItem: () => {}, removeItem: () => {} } },
    };
    globalThis.toastr = undefined;
    globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
    globalThis.FileReader = class MockFileReader {
        readAsDataURL() {
            this.result = 'data:image/png;base64,mock';
            setTimeout(() => {
                this.onload?.();
                this.onloadend?.();
            }, 0);
        }
    };
}

// ── Compressed-fixture helpers (for readResponseBody / provider tests) ──

/**
 * Сжать строку в zstd-фрейм. Требует Node ≥ 22 (zlib.zstdCompressSync).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function makeZstdFrame(input) {
    const buf = Buffer.isBuffer(input) || ArrayBuffer.isView(input)
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : Buffer.from(input, 'utf-8');
    const compressed = zstdCompressSync(buf);
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

/**
 * Сжать строку в gzip-фрейм через Node zlib.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function makeGzipFrame(input) {
    const buf = Buffer.isBuffer(input) || ArrayBuffer.isView(input)
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : Buffer.from(input, 'utf-8');
    const compressed = gzipSync(buf);
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
}

/** In-memory authoritative collections for reference-library integration tests. */
export function makeReferenceStore() {
    const collections = new Map();
    return {
        async available() { return true; },
        async list(name) { return structuredClone(collections.get(name) || []); },
        async create(name, payload) {
            const records = collections.get(name) || [];
            const persisted = { ...structuredClone(payload), updatedAt: 'server-time' };
            collections.set(name, [...records, persisted]);
            return structuredClone(persisted);
        },
        async update(name, id, payload) {
            const records = collections.get(name) || [];
            const persisted = { ...structuredClone(payload), id, updatedAt: 'server-time' };
            collections.set(name, records.map(record => record.id === id ? persisted : record));
            return structuredClone(persisted);
        },
        async updateWhere(name, predicate, makeNext) {
            const records = (collections.get(name) || []).map(record => structuredClone(record));
            const next = [];
            let affected = 0;
            for (const record of records) {
                let item = record;
                if (predicate(item)) {
                    item = { ...structuredClone(makeNext(item)), updatedAt: 'server-time' };
                    affected += 1;
                }
                next.push(item);
            }
            collections.set(name, next);
            return affected;
        },
        async delete(name, id) {
            collections.set(name, (collections.get(name) || []).filter(record => record.id !== id));
        },
    };
}

