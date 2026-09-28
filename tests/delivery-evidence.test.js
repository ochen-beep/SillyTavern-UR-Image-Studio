// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const extensionSettings = {};
const lfStore = new Map();
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }),
    libs: { localforage: {
        getItem: async key => lfStore.get(key) ?? null,
        setItem: async (key, value) => { lfStore.set(key, value); },
        removeItem: async key => { lfStore.delete(key); },
    } },
};

const store = await import('../src/connection-store.js');
const connections = await import('../src/connections.js');
const evidence = await import('../src/delivery-evidence.js');
const { normalizeConnectionRecord } = await import('../src/image-connection-schema.js');

const NOW = Date.parse('2026-09-28T12:00:00Z');
const MINUTE = 60 * 1000;

function conn(overrides = {}) {
    return { id: 'c1', endpoint: 'https://gw.test/v1', ...overrides };
}

beforeEach(async () => {
    extensionSettings.ur_image_studio = undefined;
    lfStore.clear();
    evidence._resetDeliveryEvidenceForTests();
});

test('no experience means no hint', () => {
    assert.equal(evidence.deliveryHintFor(conn()), null);
    assert.equal(evidence.deliveryHintFor(null), null);
});

test('an ambiguous direct failure routes «Авто» through the proxy for the TTL window', async () => {
    await store.createConnection(conn());
    await evidence.noteDeliveryPostOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', delivery: 'direct', ok: false, now: NOW });

    const stored = JSON.parse(JSON.stringify(lfStore.get('uris_delivery_evidence')?.c1));
    assert.equal(stored.host, 'gw.test');
    assert.ok(stored.directBrokenAt, 'факт персистится в браузер-локальном сторe');

    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + 29 * MINUTE), 'proxy');
    // TTL истёк — «Авто» снова пробует быстрый прямой путь (самолечение).
    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + 31 * MINUTE), null);
});

test('a direct success clears the broken verdict and outranks stale probe facts', async () => {
    await store.createConnection(conn());
    await evidence.noteDeliveryPostOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', delivery: 'direct', ok: false, now: NOW - 2 * 60 * MINUTE });
    await evidence.noteDeliveryPostOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', delivery: 'direct', ok: true, now: NOW });

    const stored = JSON.parse(JSON.stringify(lfStore.get('uris_delivery_evidence')?.c1));
    assert.ok(!stored.directBrokenAt, 'успешный прямой POST должен стирать вердикт «сломана»');
    assert.ok(stored.directOkAt);
    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + 5 * MINUTE), 'direct');
});

test('a proxy-delivered success writes nothing — the direct path was not exercised', async () => {
    await store.createConnection(conn());
    const result = await evidence.noteDeliveryPostOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', delivery: 'proxy', ok: true, now: NOW });
    assert.equal(result, null);
    assert.equal(lfStore.get('uris_delivery_evidence')?.c1, undefined);
});

test('an endpoint host change invalidates the experience without any form hook', async () => {
    await store.createConnection(conn());
    await evidence.noteDeliveryPostOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', delivery: 'direct', ok: false, now: NOW });
    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + MINUTE), 'proxy');

    await connections.saveConnection({ id: 'c1', endpoint: 'https://other.test/v1' });
    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + MINUTE), null, 'опыт чужого хоста не должен рулить новым');
});

test('the preflight oracle verdict marks the direct path broken', async () => {
    await store.createConnection(conn());
    await evidence.notePreflightOracleDead('c1', 'https://gw.test/v1', { now: NOW });
    assert.equal(evidence.deliveryHintFor(await store.getConnection('c1'), NOW + MINUTE), 'proxy');
});

test('unknown connection id degrades to a memory-only no-op write', async () => {
    const result = await evidence.noteDeliveryPostOutcome({ connId: 'ghost', endpoint: 'https://gw.test/v1', delivery: 'direct', ok: false, now: NOW });
    assert.ok(result);
    assert.equal(await store.getConnection('ghost'), null);
});

test('non-URL endpoints are ignored', async () => {
    const result = await evidence.noteDeliveryPostOutcome({ connId: 'c2', endpoint: 'not a url', delivery: 'direct', ok: false, now: NOW });
    assert.equal(result, null);
});

test('explicit card orders do not flow through the hint (ladder reads overrides separately)', () => {
    // Доставка «Только напрямую» — это overrides.delivery='direct'; модуль
    // опыта ничего про неё не знает и подсказку не меняет.
    const ordered = conn({ id: 'c1', overrides: { delivery: 'direct' } });
    // Опыт в памяти после записи выше по connId — подсказка честная, её
    // игнорирует лестница при явном приказе.
    assert.equal(evidence.deliveryHintFor(ordered, NOW + MINUTE), null, 'в этом тесте опыт ещё не записан');
});

// ── Опыт диалекта редактирования ────────────────────────────────────────────

test('edit dialect: successful img2img steers the chain; TTL expires back to discovery', async () => {
    await store.createConnection(conn());
    await evidence.noteEditDialectOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', dialect: 'img2img', ok: true, now: NOW });
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + 29 * MINUTE), 'img2img-proxy');
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + 31 * MINUTE), null, 'TTL — снова обнаружение с нуля');
});

test('edit dialect: json success hints json; host change invalidates', async () => {
    await store.createConnection(conn());
    await evidence.noteEditDialectOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', dialect: 'json', ok: true, now: NOW });
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + MINUTE), 'json-proxy');

    await connections.saveConnection({ id: 'c1', endpoint: 'https://other.test/v1' });
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + MINUTE), null);
});

test('edit dialect: a working multipart clears all learned skips', async () => {
    await store.createConnection(conn());
    await evidence.noteEditDialectOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', dialect: 'img2img', ok: true, now: NOW });
    await evidence.noteEditDialectOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', dialect: 'multipart', ok: true, now: NOW + MINUTE });
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + 2 * MINUTE), null, 'multipart жив — цепочка стартует с классики');
});

test('edit dialect: img2img rejection writes nothing (exhausted error is the terminal fact)', async () => {
    await store.createConnection(conn());
    await evidence.noteEditDialectOutcome({ connId: 'c1', endpoint: 'https://gw.test/v1', dialect: 'img2img', ok: false, now: NOW });
    assert.equal(evidence.editDialectHintFor(await store.getConnection('c1'), NOW + MINUTE), null);
    assert.equal(lfStore.get('uris_edit_dialect_evidence')?.c1, undefined, 'отказ img2img не персистится');
});

test('schema: legacy evidence fields are scrubbed from connection records', () => {
    const kept = normalizeConnectionRecord({
        endpoint: 'https://gw.test',
        deliveryEvidence: { host: 'gw.test', directBrokenAt: '2026-09-28T10:00:00Z' },
        editDialectEvidence: { host: 'gw.test', img2imgOkAt: '2026-09-28T10:00:00Z' },
    });
    assert.equal('deliveryEvidence' in kept, false, 'легаси-поле вырезается при нормализации');
    assert.equal('editDialectEvidence' in kept, false, 'легаси-поле вырезается при нормализации');
});
