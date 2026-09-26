// @ts-check
// Цепочка записи ключа «своего» источника (core.js setApiKey/getApiKey).
//
// CHANGELOG v0.9.4 обещал перевод ручной цепочки apiKeyState.chain на
// serialize('uris-api-key'), но код остался на своей. Контракт, который цепочка
// обязана держать в любом виде: запись — ровно последним значением и строго
// после предыдущей, а чтение, начатое до записи, не затирает свежее значение
// устаревшим ответом хранилища (revision-гварда).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
const localforage = {
    getItem: async (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: async (key, value) => { memory.set(key, value); },
    removeItem: async (key) => { memory.delete(key); },
};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) }),
    libs: { localforage },
};

const { setApiKey, getApiKey, LF_API_KEY } = await import('../src/core.js');

beforeEach(async () => {
    await localforage.removeItem(LF_API_KEY);
});

test('setApiKey пишет ключ, getApiKey читает его обратно', async () => {
    await setApiKey('sk-test');
    assert.equal(await localforage.getItem(LF_API_KEY), 'sk-test');
    assert.equal(await getApiKey(), 'sk-test');
});

test('пустой setApiKey удаляет ключ из хранилища', async () => {
    await setApiKey('sk-test');
    await setApiKey('   ');
    assert.equal(await localforage.getItem(LF_API_KEY), null);
    assert.equal(await getApiKey(), '');
});

test('серия setApiKey подряд оставляет в хранилище последнее значение', async () => {
    // Без сериализации быстрые записи обгоняют друг друга, и в хранилище
    // остаётся не последняя.
    await Promise.all([setApiKey('first'), setApiKey('second'), setApiKey('third')]);
    assert.equal(await localforage.getItem(LF_API_KEY), 'third');
});

test('getApiKey, начатый до setApiKey, не откатывает кэш к старому значению', async () => {
    await setApiKey('fresh');
    // Чтение должно по-настоящему зависнуть в хранилище, и запись обязана
    // произойти, пока оно висит, — иначе ревизии нечего защищать.
    let releaseRead;
    let readEntered;
    const blocked = new Promise(resolve => { releaseRead = resolve; });
    const entered = new Promise(resolve => { readEntered = resolve; });
    const original = localforage.getItem.bind(localforage);
    localforage.getItem = async (key) => {
        if (key === LF_API_KEY) {
            // Значение фиксируется на входе, а наружу выходит только после
            // записи: чтение честно видело старое, но узнало об этом слишком
            // поздно. Именно это ревизионная гварда не должна публиковать в кэш.
            const captured = memory.has(key) ? memory.get(key) : null;
            readEntered();
            await blocked;
            return captured;
        }
        return original(key);
    };
    try {
        const read = getApiKey();
        await entered;
        const write = setApiKey('newer');
        releaseRead();
        assert.equal(await read, 'fresh', 'само чтение возвращает то, что прочитало');
        await write;
        assert.equal(await getApiKey(), 'newer', 'позднее чтение видит новую запись, а не устаревший кэш');
    } finally {
        localforage.getItem = original;
    }
});
