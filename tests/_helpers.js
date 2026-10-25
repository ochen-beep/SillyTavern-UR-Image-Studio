// @ts-check
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Effective stylesheet text for CSS-contract tests: root style.css (without
 * its @import lines) first, then every imported styles/*.css in import
 * order. Root-first keeps "first match" lookups landing on the same rules as
 * before the split (base rules originally preceded the component sheets).
 */
export function readAllStyles() {
    const rootPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css');
    const root = readFileSync(rootPath, 'utf8');
    const imports = [];
    const rootText = root.replace(/@import\s+(?:url\()?["']([^"')]+)["']\)?[^;]*;/g, (m, p) => {
        imports.push(readFileSync(join(dirname(rootPath), p), 'utf8'));
        return '';
    });
    return [rootText, ...imports].join('\n');
}

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
// In-memory user-files surface: file-store'ы в тестах обязаны получать честный
// ответ (в новых мирах нет settings-фолбэка — недоступная поверхность = ready()
// ждёт вечно). Тесты, которым нужно конкретное содержимое, перекрывают fetch
// целиком и обслуживают эти маршруты сами.
const stubServerFiles = new Map();

export function mockFetch(handler) {
    const original = globalThis.fetch;
    const wrapped = async (url, options = {}) => {
        // Декодируем /proxy/<encoded> → исходный URL.
        let realUrl = url;
        let viaProxy = false;
        const proxyPrefix = '/proxy/';
        if (typeof url === 'string' && url.startsWith(proxyPrefix)) {
            realUrl = decodeURIComponent(url.slice(proxyPrefix.length));
            viaProxy = true;
        }
        if (realUrl === '/api/files/verify') {
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (realUrl === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            stubServerFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (typeof realUrl === 'string' && realUrl.startsWith('/user/files/')) {
            const name = decodeURIComponent(realUrl.slice('/user/files/'.length));
            if (!stubServerFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => stubServerFiles.get(name), json: async () => ({}) };
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
export function makeReferenceStore() {    const collections = new Map();
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


// ── Единый фейковый user-files сервер (замена ~19 локальных копий стба) ──
//
// Обслуживает официальную поверхность, через которую ходят все сторы:
//   POST /api/files/verify   — probe доступности (или бросает через hooks.verify)
//   POST /api/files/upload   — запись файла (тело {name, data(base64)}), с
//                              журналом uploads[] и флагом keepalive
//   GET  /user/files/<name>  — чтение (404 для неизвестных)
// Всё остальное — hooks.fallback(url, options), по умолчанию 200 OK.
//
// makeUserFileServer({ verify, onUpload, onRead, fallback }) → {
//   fetch,          // ставится в globalThis.fetch вручную (не глобально!)
//   serverFiles,    // Map<name, string> — «серверное» состояние
//   uploads,        // журнал: { name, data, keepalive }
//   reset(),        // очистить файлы и журнал
// }

/**
 * @param {{
 *   verify?: () => object|never,
 *   onUpload?: (body: object, options: object, serverFiles: Map<string,string>) => object|void,
 *   onRead?: (name: string, serverFiles: Map<string,string>) => object|void,
 *   fallback?: (url: string, options: object) => object|void,
 * }} [hooks]
 */
export function makeUserFileServer(hooks = {}) {
    const serverFiles = new Map();
    const uploads = [];
    const fetch = async (url, options = {}) => {
        const u = String(url);
        if (u === '/api/files/verify') {
            if (hooks.verify) return hooks.verify();
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            uploads.push({ name: body.name, data: body.data, keepalive: options.keepalive === true });
            serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            if (hooks.onUpload) return hooks.onUpload(body, options, serverFiles) ?? { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u.startsWith('/user/files/')) {
            const name = decodeURIComponent(u.slice('/user/files/'.length));
            if (hooks.onRead) {
                const hooked = hooks.onRead(name, serverFiles);
                if (hooked) return hooked;
            }
            if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
        }
        if (hooks.fallback) {
            const hooked = hooks.fallback(u, options);
            if (hooked) return hooked;
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    return {
        fetch,
        serverFiles,
        uploads,
        reset() { serverFiles.clear(); uploads.length = 0; },
    };
}
