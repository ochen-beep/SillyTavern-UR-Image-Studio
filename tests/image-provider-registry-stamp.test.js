// @ts-check
// Пункт 2.2: обёртка реестра переносит __urisAttempt.finalDelivery на
// invocation.request.delivery; журналы диагностики больше не источник
// управления доставкой.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { transportWithAttemptStamping } = await import('../src/image-provider-registry.js');

test('обёртка транспорта ставит delivery из __urisAttempt успешной ноги', async () => {
    const invocation = { request: { requestId: 'req-1', delivery: 'direct' } };
    const transport = transportWithAttemptStamping({
        requestJson: async () => ({ ok: true, status: 200, __urisAttempt: { initialDelivery: 'direct', finalDelivery: 'proxy', rescuedBy: 'preflight-oracle', attempts: 2 } }),
        requestMultipart: async () => { throw new Error('not used'); },
    }, invocation);
    await transport.requestJson('https://x.example/v1/generations', {});
    assert.equal(invocation.request.delivery, 'proxy', 'факт доставки удачной ноги перекрывает план');
});

test('обёртка транспорта: ответ без штампа не меняет delivery', async () => {
    const invocation = { request: { requestId: 'req-2', delivery: 'direct' } };
    const transport = transportWithAttemptStamping({
        requestJson: async () => ({ ok: true, status: 200 }),
        requestMultipart: async () => ({ ok: true, status: 200 }),
    }, invocation);
    await transport.requestJson('https://x.example/v1/generations', {});
    assert.equal(invocation.request.delivery, 'direct');
    await transport.requestMultipart('https://x.example/v1/edits', {});
    assert.equal(invocation.request.delivery, 'direct');
});

test('обёртка транспорта: ошибка ноги не штампует (штампует удавшаяся)', async () => {
    const invocation = { request: { requestId: 'req-3', delivery: 'direct' } };
    let jsonCalled = 0;
    const transport = transportWithAttemptStamping({
        requestJson: async () => { jsonCalled += 1; if (jsonCalled === 1) throw new Error('multipart leg failed'); return { ok: true, status: 200, __urisAttempt: { initialDelivery: 'direct', finalDelivery: 'proxy', rescuedBy: null, attempts: 2 } }; },
        requestMultipart: async () => { throw new Error('not used'); },
    }, invocation);
    await assert.rejects(() => transport.requestJson('u', {}));
    assert.equal(invocation.request.delivery, 'direct', 'упавшая нога не меняет штамп');
    await transport.requestJson('u', {});
    assert.equal(invocation.request.delivery, 'proxy');
});

test('grep-инвариант (пункт 2.2/2.1): image-api.js не читает журнал и detected.delivery', async () => {
    const raw = await readFile(new URL('../src/image-api.js', import.meta.url), 'utf8');
    // Вычищаем комментарии — инвариант про код, а не про текст пояснений.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /import \{ getDiagnosticSessionId, hashDiagnosticId, recordDiagnosticEvent, flushDiagnosticEvents \} from '\.\/diagnostic-events\.js';/, 'импорт журнала без listDiagnosticEvents');
    assert.doesNotMatch(src, /listDiagnosticEvents/, 'журнал диагностики не читается image-api.js');
    assert.doesNotMatch(src, /detected\?\.delivery|detected\.delivery/, 'detected.delivery не читается диспетчем (единая память — delivery-evidence)');
    assert.doesNotMatch(src, /_hostStrategy/, '_hostStrategy не читается платными POST');
});
