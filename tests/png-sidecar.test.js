// @ts-check
// Фаза 4: PNG iTXt-сайдкар — запись/чтение, края (не-PNG, перебор размера).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedUrisSidecar, readUrisSidecar } from '../src/png-sidecar.js';

function makePng() {
    // Минимально валидный каркас: SIG + IHDR(13 нулей) + IDAT(1 байт) + IEND.
    // CRC не считаем: читатель его не проверяет, а хирургия чанков его не трогает.
    const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
    const chunk = (type, data) => {
        const t = new TextEncoder().encode(type);
        const out = new Uint8Array(12 + data.length);
        out.set(u32(data.length), 0); out.set(t, 4); out.set(data, 8); // crc — нули
        return out;
    };
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', new Uint8Array(13)),
        chunk('IDAT', new Uint8Array([7])),
        chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

test('round-trip: промпт с юникодом доезжает внутри PNG', async () => {
    const meta = { v: 1, prompt: 'Ханна смотрит — Élodie ♥', model: 'gemini-3.1-flash-image', refs: ['r1', 'r2'] };
    const embedded = await embedUrisSidecar(new Blob([makePng()], { type: 'image/png' }), meta);
    assert.equal(embedded.type, 'image/png');
    assert.ok(embedded.size > makePng().length);
    assert.deepEqual(await readUrisSidecar(embedded), meta);
    // ArrayBuffer-путь читателя тоже работает.
    assert.deepEqual(await readUrisSidecar(await embedded.arrayBuffer()), meta);
});

test('чужие/граничные входы не ломаются', async () => {
    // не PNG по mime — passthrough
    const jpg = new Blob([makePng()], { type: 'image/jpeg' });
    assert.equal(await embedUrisSidecar(jpg, { a: 1 }), jpg);
    // PNG по байтам, но blob.type пустой — сайдкар не пишем (провайдеры без mime)
    const noMime = new Blob([makePng()]);
    assert.equal(await embedUrisSidecar(noMime, { a: 1 }), noMime);
    // null meta
    const png = new Blob([makePng()], { type: 'image/png' });
    assert.equal(await embedUrisSidecar(png, null), png);
    // перебор размера
    const big = await embedUrisSidecar(png, { prompt: 'x'.repeat(100_000) });
    assert.equal(big, png);
    // чтение PNG без чанка → null; мусор → null
    assert.equal(await readUrisSidecar(new Blob([makePng()])), null);
    assert.equal(await readUrisSidecar(new TextEncoder().encode('not a png').buffer), null);
});

test('чанк встаёт после IHDR (валидный порядок чанков)', async () => {
    const embedded = await embedUrisSidecar(new Blob([makePng()], { type: 'image/png' }), { v: 1 });
    const buf = new Uint8Array(await embedded.arrayBuffer());
    const ihdrLen = new DataView(buf.buffer).getUint32(8);
    const typeAt = 8 + 12 + ihdrLen + 4;
    assert.equal(String.fromCharCode(...buf.subarray(typeAt, typeAt + 4)), 'iTXt');
});
