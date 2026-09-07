// @ts-check
// Unit-тесты для сетевого дампера (src/netdump.js).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();

// Локальный in-memory localforage (перекрывает заглушку из installStGlobals).
const _store = new Map();
before(() => {
    globalThis.SillyTavern.libs.localforage = {
        getItem: async (k) => (_store.has(k) ? structuredClone(_store.get(k)) : null),
        setItem: async (k, v) => { _store.set(k, structuredClone(v)); },
        removeItem: async (k) => { _store.delete(k); },
    };
});
beforeEach(() => { _store.clear(); });

const {
    filterHeaders, filterRequestBody, filterResponseBody,
    compactBase64Blobs, classifyUrl,
    recordNetEntry, getNetDumpsCount, clearNetDumps,
    recordFromFetch, recordFromFetchError, buildNetDumpPayload,
    recordFromProfile, recordFromProfileError,
    MAX_NET_ENTRIES, LF_NETDUMP,
} = await import('../src/netdump.js');

// ── filterHeaders ──

test('filterHeaders: вырезает Authorization и x-goog-api-key', () => {
    const out = filterHeaders({
        'Authorization': 'Bearer secret',
        'x-goog-api-key': 'AIza-secret',
        'api-key': 'sk-secret',
        'X-API-KEY': 'secret',
        'Content-Type': 'application/json',
    });
    assert.equal(out['Authorization'], '<redacted>');
    assert.equal(out['x-goog-api-key'], '<redacted>');
    assert.equal(out['api-key'], '<redacted>');
    assert.equal(out['X-API-KEY'], '<redacted>');
    assert.equal(out['Content-Type'], 'application/json');
});

test('filterHeaders: null/undefined проходит без ошибки', () => {
    assert.equal(filterHeaders(null), null);
    assert.equal(filterHeaders(undefined), undefined);
});

// ── compactBase64Blobs ──

test('compactBase64Blobs: сворачивает inlineData.data в { mimeType, _bytes }', () => {
    const body = {
        contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/webp', data: 'A'.repeat(50000) } },
            { text: 'prompt text stays' },
        ] }],
    };
    const out = compactBase64Blobs(body);
    const ref = out.contents[0].parts[0].inlineData;
    assert.equal(ref.mimeType, 'image/webp');
    assert.equal(ref._bytes, 50000);
    assert.equal(ref._kind, 'inlineData-dropped');
    assert.equal(out.contents[0].parts[1].text, 'prompt text stays');
});

test('compactBase64Blobs: snake_case inline_data тоже сворачивается', () => {
    const out = compactBase64Blobs({
        parts: [{ inline_data: { mime_type: 'image/png', data: 'B'.repeat(300) } }],
    });
    assert.equal(out.parts[0].inline_data.mime_type, 'image/png');
    assert.equal(out.parts[0].inline_data._bytes, 300);
});

test('compactBase64Blobs: короткая data (<128 байт) не сворачивается', () => {
    const out = compactBase64Blobs({ inlineData: { mimeType: 'image/png', data: 'short' } });
    assert.equal(out.inlineData.data, 'short');
});

// Regression (realdump 04-52): keep-ключ 'text' сворачивался в long-string-dropped
// потому что ранний рекурсивный return для строки не проверял keep-set. Тогда в дампе
// текст ответа модели превращался в {"_kind":"long-string-dropped","_bytes":6031}
// и была видна только метадлина, а не сам текст ("[object Object]" в логе).
test('compactBase64Blobs: длинный text-keepkey сохраняется как строка, не сворачивается', () => {
    const longText = 'This is a complex request. To provide '.repeat(300); // ~10.8 KB > MAX_TEXT_BYTES
    const out = compactBase64Blobs({ parts: [{ text: longText }] });
    assert.equal(typeof out.parts[0].text, 'string', 'text должен остаться строкой');
    assert.ok(out.parts[0].text.includes('complex request'), 'содержимое text сохранено');
    // Длиннее MAX_TEXT_BYTES → компактор обрезает, но оставляет строкой с маркером.
    assert.match(out.parts[0].text, /\[truncated\]$/, 'очень длинный text обрезается до MAX_TEXT_BYTES');
});

test('compactBase64Blobs: thoughtSignature (не-keep) сворачивается, text рядом сохраняется', () => {
    const out = compactBase64Blobs({
        parts: [
            { thoughtSignature: 'Eo' + 'x'.repeat(3000), text: 'panel description' },
            { text: 'короткий' },
        ],
    });
    assert.equal(out.parts[0].thoughtSignature._kind, 'long-string-dropped');
    assert.equal(out.parts[0].thoughtSignature._bytes, 3002);
    assert.equal(out.parts[0].text, 'panel description');   // короткий keep-text нетронут
    assert.equal(out.parts[1].text, 'короткий');
});

// ── filterRequestBody ──

test('filterRequestBody: JSON-строка парсится и сворачивается', () => {
    const body = JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'Z'.repeat(10000) } }] }],
    });
    const out = filterRequestBody(body);
    assert.equal(out.contents[0].parts[0].text, 'hi');
    assert.equal(out.contents[0].parts[1].inlineData._kind, 'inlineData-dropped');
});

test('filterRequestBody: не-JSON строка обрезается', () => {
    const long = 'x'.repeat(20000);
    const out = filterRequestBody(long);
    assert.match(out, /\[truncated\]$/);
    assert.ok(out.length < long.length);
});

// Запросы не имели общего лимита: окно сообщений text-LLM (десятки KB,
// дублирующихся между записями) писалось целиком. Теперь — head+tail preview.
test('filterRequestBody: JSON-запрос > 32KB → head+tail preview, системный и текущий промпт сохранены', () => {
    const messages = [{ role: 'system', content: 'SYSTEM PROMPT' }];
    for (let i = 0; i < 20; i++) messages.push({ role: 'user', content: 'история ' + 'x'.repeat(2000) });
    messages.push({ role: 'user', content: 'FINAL PROMPT' });
    const raw = JSON.stringify({ model: 'm', messages });
    const out = filterRequestBody(raw);
    assert.equal(out._kind, 'json');
    assert.equal(out._truncated, true);
    assert.match(out.preview, /chars truncated/);
    assert.ok(out.preview.includes('SYSTEM PROMPT'), 'голова: системный промпт сохранён');
    assert.ok(out.preview.includes('FINAL PROMPT'), 'хвост: текущий промпт сохранён');
    assert.equal(out._bytes, raw.length, '_bytes — исходный размер запроса');
    assert.equal(out._previewBytes, 24576 + 8192);
});

test('filterRequestBody: маленький JSON-запрос остаётся полным объектом без обёртки', () => {
    const out = filterRequestBody(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    assert.deepEqual(out, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
});

// ── filterResponseBody ──

test('filterResponseBody: image → { _kind:"image", mime, _bytes, _skipped }', () => {
    // PNG magic bytes.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
    const out = filterResponseBody({ bytes: pngBytes, text: null, mime: 'image/png' });
    assert.equal(out._kind, 'image');
    assert.equal(out.mime, 'image/png');
    assert.equal(out._skipped, true);
    assert.equal(out._bytes, pngBytes.length);
});

test('filterResponseBody: JSON → полный объект с _kind:"json"', () => {
    const obj = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }] };
    const text = JSON.stringify(obj);
    const out = filterResponseBody({ bytes: new TextEncoder().encode(text), text, mime: null });
    assert.equal(out._kind, 'json');
    assert.deepEqual(out.json, obj);
    assert.equal(out._bytes, text.length);
});

test('filterResponseBody: текстовый ответ → _kind:"text"', () => {
    const text = 'I cannot generate this image due to safety.';
    const out = filterResponseBody({ bytes: new TextEncoder().encode(text), text, mime: null });
    assert.equal(out._kind, 'text');
    assert.equal(out.text, text);
});

// Regression: Gemini image-success answer carries a multi-MB base64 thoughtSignature
// next to inlineData. Without the long-string compactor the dump ballooned to 7 MB.
// См. реальный дамп 2026-07-14T04-12-53 (entry 2, _bytes:10985754).
test('filterResponseBody: thoughtSignature (мегабайтный base64) сворачивается, JSON входит в лимит', () => {
    // Реалистичный ответ Gemini image: картинка (inlineData) + мысль (thoughtSignature).
    const hugeSig = 'Eo' + 'x'.repeat(3_000_000); // ~3 МБ base64
    const obj = {
        candidates: [{
            content: { role: 'model', parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'A'.repeat(3_800_000) } },
                { thoughtSignature: hugeSig, text: 'panel description' },
            ] },
            finishReason: 'STOP', index: 0, safetyRatings: null,
        }],
        usageMetadata: { totalTokenCount: 3081 },
        modelVersion: 'gemini-3.1-flash-image',
    };
    const text = JSON.stringify(obj);
    const out = filterResponseBody({ bytes: new TextEncoder().encode(text), text, mime: null });
    assert.equal(out._kind, 'json');
    // Полный JSON (после компактора) должен быть МЕНЬШЕ 64 КБ — блобы свёрнуты.
    assert.ok(JSON.stringify(out.json).length < 65536, 'должен войти в лимит без truncation');
    const part = out.json.candidates[0].content.parts;
    // Картинка свёрнута inlineData-dropped.
    assert.equal(part[0].inlineData._kind, 'inlineData-dropped');
    // thoughtSignature свёрнут long-string-dropped — НЕ мегабайтная base64 в дампе.
    assert.equal(part[1].thoughtSignature._kind, 'long-string-dropped');
    assert.equal(part[1].thoughtSignature._bytes, hugeSig.length);
    // text-часть рядом сохранена (нужна для анализа).
    assert.equal(part[1].text, 'panel description');
    // finishReason/modelVersion на месте.
    assert.equal(out.json.candidates[0].finishReason, 'STOP');
    assert.equal(out.json.modelVersion, 'gemini-3.1-flash-image');
});

// Regression: компактор сворачивает блобы, но если ответ содержит много строковых
// полей (много parts/candidates с человекочитаемым текстом), общий компакт-JSON всё
// равно может превысить MAX_JSON_BYTES. Раньше _truncated ставился, но полный json
// не обрезался → дамп оставался гигантским. Теперь — реальная обрезка в preview.
test('filterResponseBody: JSON > 64KB после компактора → _truncated с preview, без полного json', () => {
    // Много keep-key полей: каждый part — короткий text (~45 байт, под MAX_TEXT_BYTES),
    // компактор их сохраняет, но суммарно > 64 KB → срабатывает truncation.
    const parts = [];
    for (let i = 0; i < 5000; i++) parts.push({ text: 'The quick brown fox jumps over the lazy dog. ' });
    const obj = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], modelVersion: 'gemini-test' };
    const text = JSON.stringify(obj);
    const out = filterResponseBody({ bytes: new TextEncoder().encode(text), text, mime: null });
    assert.equal(out._kind, 'json');
    assert.equal(out._truncated, true);
    assert.ok(out.preview.length <= 65536, 'preview должен быть обрезан');
    assert.equal(out.json, undefined, 'полный json НЕ должен сохраняться при truncation');
    assert.ok(out.preview.includes('"candidates"'), 'preview содержит начало структуры');
    assert.equal(out._bytes, text.length);
    assert.ok(out._previewBytes <= 65536);
});

test('filterResponseBody: Naistera JSON сохраняет безопасные shape-метаданные', () => {
    const obj = {
        status: 'completed',
        job_id: 'job_123',
        media_kind: 'image',
        result: { b64_json: 'A'.repeat(500000) },
        prompt: 'private prompt',
    };
    const text = JSON.stringify(obj);
    const out = filterResponseBody({ bytes: new TextEncoder().encode(text), text, mime: null });
    assert.equal(out._kind, 'json');
    assert.equal(out.json.status, 'completed');
    assert.equal(out.json.result.b64_json._kind, 'long-string-dropped');
    assert.equal(out.json.prompt, 'private prompt');
});


test('classifyUrl: skip для /api/secrets и probe example.com', () => {
    assert.equal(classifyUrl('/api/secrets/write').skip, true);
    assert.equal(classifyUrl('/proxy/' + encodeURIComponent('https://example.com/')).skip, true);
});

test('classifyUrl: Gemini generateContent с -image → image-gemini; без → text-llm', () => {
    assert.equal(classifyUrl('https://linkapi.ai/v1beta/models/gemini-3.1-flash-image:generateContent').kind, 'image-gemini');
    assert.equal(classifyUrl('https://linkapi.ai/v1beta/models/gemini-3-pro:generateContent').kind, 'text-llm');
});

test('classifyUrl: proxy-путь декодируется', () => {
    const r = classifyUrl('/proxy/' + encodeURIComponent('https://api.x.com/v1/images/generations'));
    assert.equal(r.skip, false);
    assert.equal(r.kind, 'image');
    assert.equal(r.host, 'api.x.com');
});

test('classifyUrl: chat/completions → text-llm', () => {
    const r = classifyUrl('https://api.openai.com/v1/chat/completions');
    assert.equal(r.kind, 'text-llm');
});

// ── recordNetEntry / ротация ──

test('recordNetEntry: пишет запись в localforage', async () => {
    const before = await getNetDumpsCount();
    assert.equal(before, 0);
    await recordNetEntry({ id: 'x1', kind: 'image', host: 'h', url: 'u' });
    assert.equal(await getNetDumpsCount(), 1);
});

test('recordNetEntry: ротация при превышении MAX_NET_ENTRIES', async () => {
    // Тест занимает время; используем сниженный лимит через засыпку bulk.
    // Простейший путь: пишем > MAX_NET_ENTRIES, проверяем, что осталось ровно лимит.
    for (let i = 0; i < MAX_NET_ENTRIES + 5; i++) {
        await recordNetEntry({ id: `r${i}`, kind: 'image', host: 'h', url: 'u' });
    }
    const count = await getNetDumpsCount();
    assert.equal(count, MAX_NET_ENTRIES);
    // Самые старые (r0..r4) должны быть вытеснены.
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.ok(entries.every((e) => !['r0', 'r1', 'r2', 'r3', 'r4'].includes(e.id)));
});

test('recordNetEntry: concurrent read-modify-write calls keep every entry', async () => {
    const originalSetItem = globalThis.SillyTavern.libs.localforage.setItem;
    globalThis.SillyTavern.libs.localforage.setItem = async (key, value) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return originalSetItem(key, value);
    };
    try {
        await Promise.all(Array.from({ length: 12 }, (_, i) => recordNetEntry({ id: `concurrent-${i}`, kind: 'image' })));
        const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
        assert.equal(entries.length, 12);
        assert.deepEqual(new Set(entries.map(entry => entry.id)), new Set(Array.from({ length: 12 }, (_, i) => `concurrent-${i}`)));
    } finally {
        globalThis.SillyTavern.libs.localforage.setItem = originalSetItem;
    }
});

test('clearNetDumps: очищает хранилище', async () => {
    await recordNetEntry({ id: 'x', kind: 'image', host: 'h', url: 'u' });
    assert.equal(await getNetDumpsCount(), 1);
    await clearNetDumps();
    assert.equal(await getNetDumpsCount(), 0);
});

test('buildNetDumpPayload: waits for recorder body processing before reading storage', async () => {
    let resolveBody;
    const bodyReady = new Promise(resolve => { resolveBody = resolve; });
    const response = {
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        clone() {
            return {
                async arrayBuffer() {
                    await bodyReady;
                    return new TextEncoder().encode('{}').buffer;
                },
            };
        },
    };
    const recording = recordFromFetch('https://api.x.com/v1/images/generations', { method: 'POST' }, response, 1);
    let exported = false;
    const exportPromise = buildNetDumpPayload().then(payload => { exported = true; return payload; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(exported, false, 'export waits while response body is being compacted');
    resolveBody();
    await recording;
    const payload = await exportPromise;
    assert.equal(payload.meta.count, 1);
    assert.equal(payload.entries[0].kind, 'image');
});

// ── recordFromFetch / recordFromFetchError ──

test('recordFromFetch: успешный ответ → запись с resp.body', async () => {
    const body = JSON.stringify({ candidates: [{ finishReason: 'STOP' }] });
    const resp = new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cf-ray': 'ray-1' } });
    await recordFromFetch('https://api.x.com/v1bp/models/m:generateContent', {
        method: 'POST',
        __urisDiagnostic: {
            requestId: 'req-1', attemptId: 'attempt-1', attemptIndex: 0,
            expectedReferenceCount: 2, encodedReferenceCount: 2,
            references: [{ id: 'ref-1', name: 'Aria', mime: 'image/webp', bytes: 1234, encoding: 'inlineData' }],
        },
    }, resp, 42);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].resp.status, 200);
    assert.equal(entries[0].resp.body._kind, 'json');
    assert.equal(entries[0].resp.headers['cf-ray'], 'ray-1');
    // Structured dispatch metadata is NOT duplicated here — it lives in the
    // diagnostic journal; only the correlation key is kept.
    assert.equal(entries[0].requestId, 'req-1');
    assert.equal(entries[0].diagnostic, undefined);
    assert.equal(entries[0].resp.jsonMeta, undefined);
    assert.equal(entries[0].resp.envelope, undefined);
    assert.equal(entries[0].durationMs, 42);
});

test('recordFromFetchError: сетевая ошибка → запись с error', async () => {
    await recordFromFetchError('https://api.x.com/v1/images/generations', { method: 'POST' }, new Error('Failed to fetch'), 5);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.match(entries[0].error, /Failed to fetch/);
    assert.equal(entries[0].resp, null);
});

test('recordFromFetch: dispatch-метаданные не дублируются — только requestId', async () => {
    const resp = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await recordFromFetch('https://api.x.com/v1/images/generations', {
        method: 'POST',
        __urisDiagnostic: {
            requestId: 'req-2', modelId: 'gpt-image-2', generationContract: 'openai-images',
            requested: { aspectRatio: '16:9', imageSize: '1K', quality: 'auto' },
        },
    }, resp, 1);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries[0].requestId, 'req-2');
    assert.equal(entries[0].diagnostic, undefined, 'структурный diagnostic-блок не пишется');
});

test('recordFromFetch: записи каталогов моделей (kind=models) не пишутся', async () => {
    const resp = new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
    });
    await recordFromFetch('https://api.openai.com/v1/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://gen.pollinations.ai/image/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://naistera.org/api/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://openrouter.ai/api/v1/images/models', { method: 'GET' }, resp, 1);
    assert.equal(await getNetDumpsCount(), 0, 'каталожные запросы не попадают в журнал');
});

test('recordFromFetch: provider-факты ответа остаются в resp.body, без jsonMeta-копии', async () => {
    const body = JSON.stringify({
        created: 1,
        size: '1536x1024',
        output_format: 'png',
        quality: 'medium',
        background: 'opaque',
        data: [{ url: 'https://cdn.example/x.png' }],
        usage: { input_tokens: 1976, output_tokens: 861, total_tokens: 2837, nested_skip: {} },
    });
    const resp = new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    await recordFromFetch('https://api.x.com/v1/images/edits', { method: 'POST' }, resp, 1);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries[0].resp.jsonMeta, undefined, 'jsonMeta удалён');
    // Те же факты доступны в полном теле ответа рядом.
    const json = entries[0].resp.body.json;
    assert.equal(json.size, '1536x1024');
    assert.equal(json.output_format, 'png');
    assert.deepEqual(json.usage, { input_tokens: 1976, output_tokens: 861, total_tokens: 2837, nested_skip: {} });
    assert.equal(json.data.length, 1);
});

test('recordFromFetch: auth-headers вырезаются в записи', async () => {
    const resp = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await recordFromFetch('https://api.x.com/v1/chat/completions',
        { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } }, resp, 1);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries[0].req.headers.Authorization, '<redacted>');
    assert.equal(entries[0].req.headers['Content-Type'], 'application/json');
});

test('recordFromFetch: skip для внутренних роутов ST (/api/secrets)', async () => {
    const resp = new Response('{}', { status: 200 });
    await recordFromFetch('/api/secrets/write', { method: 'POST' }, resp, 1);
    assert.equal(await getNetDumpsCount(), 0);
});

// ── recordFromProfile / recordFromProfileError ──

test('recordFromProfile: пишет profile + messages + extracted', async () => {
    const profile = { id: 'p1', name: 'Deepseek', model: 'deepseek-chat' };
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }];
    const response = { choices: [{ message: { content: 'result text' } }] };
    await recordFromProfile(profile, messages, response, 100);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'text-llm-profile');
    assert.equal(entries[0].req.profile.id, 'p1');
    assert.equal(entries[0].req.messages.length, 2);
    assert.equal(entries[0].req.messages[0].content, 'sys');
    assert.equal(entries[0].resp.extracted, 'result text');
});

test('recordFromProfileError: пишет ошибку профиля', async () => {
    const profile = { id: 'p1', name: 'Deepseek' };
    await recordFromProfileError(profile, [], new Error('boom'), 50);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.match(entries[0].error, /boom/);
    assert.equal(entries[0].resp, null);
});

// ── fetchWithTimeout integration: recorder НЕ блокирует основной путь ──

test('fetchWithTimeout: ошибка рекордера не валит генерацию', async () => {
    // Ломаем SillyTavern.localforage, чтобы рекордер упал; fetch должен пройти.
    const goodLf = globalThis.SillyTavern.libs.localforage;
    globalThis.SillyTavern.libs.localforage = {
        getItem: async () => { throw new Error('IDB broken'); },
        setItem: async () => { throw new Error('IDB broken'); },
        removeItem: async () => {},
    };
    const restore = mockFetch(() => ({ ok: true, status: 200, text: async () => 'ok' }));
    const { fetchWithTimeout } = await import('../src/core.js');
    try {
        const resp = await fetchWithTimeout('https://api.x.com/v1/chat/completions', { method: 'POST' }, 5000);
        assert.equal(resp.status, 200);
    } finally {
        globalThis.SillyTavern.libs.localforage = goodLf;
        restore();
    }
});