// @ts-check
// Unit-тесты для сетевого дампера (src/netdump.js).
// Главный контракт (v2, формат «metadata, not bodies»): в записях нет тел —
// ни промптов, ни текстов модели, ни значений заголовков; только адреса
// (со скраббингом), статусы, длительности, имена заголовков и размеры/типы тел.
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
    filterHeaders, filterRequestBody, classifyUrl,
    recordNetEntry, getNetDumpsCount, clearNetDumps,
    recordFromFetch, recordFromFetchError, buildNetDumpPayload,
    recordFromProfile, recordFromProfileError,
    MAX_NET_ENTRIES, LF_NETDUMP,
} = await import('../src/netdump.js');

// ── filterHeaders: только имена, никаких значений ──

test('filterHeaders: возвращает только имена заголовков — значения (включая auth) не сохраняются', () => {
    const out = filterHeaders({
        'Authorization': 'Bearer secret',
        'x-goog-api-key': 'AIza-secret',
        'Content-Type': 'application/json',
    });
    assert.deepEqual(out, ['Authorization', 'x-goog-api-key', 'Content-Type']);
    // Ни одно значение не просочилось.
    assert.equal(JSON.stringify(out).includes('secret'), false);
});

test('filterHeaders: null/undefined проходит без ошибки', () => {
    assert.equal(filterHeaders(null), null);
    assert.equal(filterHeaders(undefined), undefined);
});

// ── filterRequestBody: только тип и размер, никакого содержимого ──

test('filterRequestBody: JSON-строка → {_kind:"json", _bytes}, без содержимого', () => {
    const raw = JSON.stringify({
        contents: [{ parts: [{ text: 'PROMPT TEXT must not leak' }] }],
    });
    const out = filterRequestBody(raw);
    assert.deepEqual(out, { _kind: 'json', _bytes: raw.length });
    assert.equal(JSON.stringify(out).includes('PROMPT TEXT'), false);
});

test('filterRequestBody: не-JSON строка → {_kind:"text", _bytes}', () => {
    const long = 'x'.repeat(20000);
    const out = filterRequestBody(long);
    assert.deepEqual(out, { _kind: 'text', _bytes: 20000 });
    assert.equal(JSON.stringify(out).includes('xxx'), false);
});

test('filterRequestBody: FormData → имена полей и типы/размеры блобов, без значений', () => {
    const fd = new FormData();
    fd.append('prompt', 'private prompt text');
    fd.append('image', new Blob(['x'.repeat(12345)], { type: 'image/png' }));
    const out = filterRequestBody(fd);
    assert.equal(out._kind, 'form');
    assert.deepEqual(out.fields, [
        { field: 'prompt', kind: 'text' },
        { field: 'image', kind: 'blob', type: 'image/png', size: 12345 },
    ]);
    assert.equal(JSON.stringify(out).includes('private prompt text'), false, 'значение поля не сохраняется');
});

test('filterRequestBody: object → {_kind:"json", _bytes}; прочее → other; null → null', () => {
    const obj = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const out = filterRequestBody(obj);
    assert.deepEqual(out, { _kind: 'json', _bytes: JSON.stringify(obj).length });
    assert.deepEqual(filterRequestBody('raw'), { _kind: 'text', _bytes: 3 });
    assert.equal(filterRequestBody(null), null);
});

// ── classifyUrl ──

test('classifyUrl: skip для /api/secrets и probe example.com', () => {
    assert.equal(classifyUrl('/api/secrets/write').skip, true);
    assert.equal(classifyUrl('/proxy/' + encodeURIComponent('https://example.com/')).skip, true);
});

test('classifyUrl: Gemini generateContent с -image → image-gemini; без → text-llm', () => {
    assert.equal(classifyUrl('https://relay.example/v1beta/models/gemini-3.1-flash-image:generateContent').kind, 'image-gemini');
    assert.equal(classifyUrl('https://relay.example/v1beta/models/gemini-3-pro:generateContent').kind, 'text-llm');
    // Имя без слова «image» (Nano Banana 2.1) тоже классифицируется как image.
    assert.equal(classifyUrl('https://relay.example/v1beta/models/gemini-nano-banana-2.1:generateContent').kind, 'image-gemini');
    // Interactions API: модель в теле, классификация по пути.
    assert.equal(classifyUrl('https://generativelanguage.googleapis.com/v1beta/interactions').kind, 'image-gemini');
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
    await recordNetEntry({ v: 2, id: 'x1', kind: 'image', host: 'h', url: 'u' });
    assert.equal(await getNetDumpsCount(), 1);
});

test('recordNetEntry: ротация при превышении MAX_NET_ENTRIES', async () => {
    for (let i = 0; i < MAX_NET_ENTRIES + 5; i++) {
        await recordNetEntry({ v: 2, id: `r${i}`, kind: 'image', host: 'h', url: 'u' });
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
        await Promise.all(Array.from({ length: 12 }, (_, i) => recordNetEntry({ v: 2, id: `concurrent-${i}`, kind: 'image' })));
        const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
        assert.equal(entries.length, 12);
        assert.deepEqual(new Set(entries.map(entry => entry.id)), new Set(Array.from({ length: 12 }, (_, i) => `concurrent-${i}`)));
    } finally {
        globalThis.SillyTavern.libs.localforage.setItem = originalSetItem;
    }
});

test('clearNetDumps: очищает хранилище', async () => {
    await recordNetEntry({ v: 2, id: 'x', kind: 'image', host: 'h', url: 'u' });
    assert.equal(await getNetDumpsCount(), 1);
    await clearNetDumps();
    assert.equal(await getNetDumpsCount(), 0);
});

// Записи формата v1 содержали обрезанные тела (промпты/ответы). После апгрейда
// дамп под флагом «metadata only» не имеет права их экспортировать — v1-записи
// вычищаются при первом же чтении.
test('миграция v1→v2: старые записи с телами вычищаются, не экспортируются', async () => {
    await globalThis.SillyTavern.libs.localforage.setItem(LF_NETDUMP, [
        { id: 'legacy-1', kind: 'image', url: 'u', req: { body: { prompt: 'old prompt' } }, resp: { body: { json: { text: 'old model text' } } } },
    ]);
    assert.equal(await getNetDumpsCount(), 0, 'записи без v:2 не считаются');
    const payload = await buildNetDumpPayload();
    assert.equal(payload.meta.count, 0);
    assert.equal(payload.meta.version, 2);
});

// ── recordFromFetch / recordFromFetchError ──

test('recordFromFetch: метаданные ответа — kind/contentType/длина из заголовков, тело не читается', async () => {
    const resp = new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '123', 'cf-ray': 'ray-1' },
    });
    // Клон с падающим чтением тела: рекордер не должен его читать вообще.
    resp.clone = () => { throw new Error('body must not be read'); };
    await recordFromFetch('https://api.x.com/v1bp/models/m:generateContent', {
        method: 'POST',
        body: JSON.stringify({ contents: [{ parts: [{ text: 'PROMPT must not leak' }] }] }),
        __urisDiagnostic: { requestId: 'req-1', attemptId: 'attempt-1', attemptIndex: 0 },
    }, resp, 42);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v, 2);
    assert.equal(entries[0].resp.status, 200);
    assert.equal(entries[0].resp.body._kind, 'json');
    assert.equal(entries[0].resp.body.contentType, 'application/json');
    assert.equal(entries[0].resp.body._bytes, 123);
    assert.equal(entries[0].resp.headers['cf-ray'], 'ray-1');
    assert.equal(entries[0].requestId, 'req-1');
    assert.equal(entries[0].durationMs, 42);
    // Главный приватный контракт: никакого содержимого в записи.
    const serialized = JSON.stringify(entries[0]);
    assert.equal(serialized.includes('PROMPT must not leak'), false, 'тело запроса не пишется');
    assert.equal(serialized.includes('"candidates"'), false, 'тело ответа не пишется');
});

test('recordFromFetch: тип тела ответа выводится из content-type (image/text/json/unknown)', async () => {
    const make = (ct, body) => new Response(body ?? null, { status: 200, headers: ct ? { 'content-type': ct } : {} });
    await recordFromFetch('https://api.x.com/v1/images/generations', { method: 'POST' }, make('image/png', ''), 1);
    await recordFromFetch('https://api.x.com/v1/images/generations2', { method: 'POST' }, make('text/plain', ''), 1);
    await recordFromFetch('https://api.x.com/v1/images/generations3', { method: 'POST' }, make('application/json', ''), 1);
    // Response со строковым телом сам проставляет text/plain — для «unknown» нужен null-body.
    await recordFromFetch('https://api.x.com/v1/images/generations4', { method: 'POST' }, make(''), 1);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.deepEqual(entries.map(e => e.resp.body._kind), ['image', 'text', 'json', 'unknown']);
    // Ни одна запись не содержит тело.
    assert.ok(entries.every(e => e.resp.body.text === undefined && e.resp.body.json === undefined));
});

test('recordFromFetchError: сетевая ошибка → запись с error', async () => {
    await recordFromFetchError('https://api.x.com/v1/images/generations', { method: 'POST' }, new Error('Failed to fetch'), 5);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.match(entries[0].error, /Failed to fetch/);
    assert.equal(entries[0].resp, null);
    assert.equal(entries[0].req.body, null);
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
    const resp = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await recordFromFetch('https://api.openai.com/v1/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://gen.pollinations.ai/image/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://naistera.org/api/models', { method: 'GET' }, resp, 1);
    await recordFromFetch('https://openrouter.ai/api/v1/images/models', { method: 'GET' }, resp, 1);
    assert.equal(await getNetDumpsCount(), 0, 'каталожные запросы не попадают в журнал');
});

test('recordFromFetch: заголовки запроса сохраняются только именами', async () => {
    const resp = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await recordFromFetch('https://api.x.com/v1/chat/completions',
        { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } }, resp, 1);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.deepEqual(entries[0].req.headers, ['Authorization', 'Content-Type']);
    assert.equal(JSON.stringify(entries[0]).includes('secret'), false);
});

test('recordFromFetch: skip для внутренних роутов ST (/api/secrets)', async () => {
    const resp = new Response('{}', { status: 200 });
    await recordFromFetch('/api/secrets/write', { method: 'POST' }, resp, 1);
    assert.equal(await getNetDumpsCount(), 0);
});

// ── recordFromProfile / recordFromProfileError ──

test('recordFromProfile: профиль + роли сообщений + ключи ответа; без контента', async () => {
    const profile = { id: 'p1', name: 'Deepseek', model: 'deepseek-chat' };
    const messages = [{ role: 'system', content: 'SECRET SYSTEM PROMPT' }, { role: 'user', content: 'SECRET USER TEXT' }];
    const response = { choices: [{ message: { content: 'SECRET RESULT TEXT' } }] };
    await recordFromProfile(profile, messages, response, 100);
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'text-llm-profile');
    assert.equal(entries[0].req.profile.id, 'p1');
    assert.deepEqual(entries[0].req.messages, { count: 2, roles: ['system', 'user'] });
    assert.deepEqual(entries[0].resp, { ok: true, keys: ['choices'] });
    const serialized = JSON.stringify(entries[0]);
    for (const secret of ['SECRET SYSTEM PROMPT', 'SECRET USER TEXT', 'SECRET RESULT TEXT']) {
        assert.equal(serialized.includes(secret), false, `контент «${secret}» не пишется`);
    }
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

test('recordNetEntry: ротация вытесняет успешные записи раньше ошибочных', async () => {
    for (let i = 0; i < 3; i++) {
        await recordNetEntry({ v: 2, id: `err${i}`, kind: 'image', host: 'h', url: 'u', error: 'boom' });
    }
    for (let i = 0; i < MAX_NET_ENTRIES; i++) {
        await recordNetEntry({ v: 2, id: `ok${i}`, kind: 'image', host: 'h', url: 'u', error: null });
    }
    const entries = await globalThis.SillyTavern.libs.localforage.getItem(LF_NETDUMP);
    assert.equal(entries.length, MAX_NET_ENTRIES);
    assert.ok(entries.every(e => !['ok0', 'ok1', 'ok2'].includes(e.id)), 'oldest successes are evicted first');
    assert.deepEqual(
        entries.filter(e => String(e.id).startsWith('err')).map(e => e.id),
        ['err0', 'err1', 'err2'],
        'error entries outlive the rotation',
    );
});

// Экспорт, начатый сразу после ответа, не должен потерять запись: fire-and-forget
// рекордер отслеживается, buildNetDumpPayload ждёт его завершения. Рекордер
// тормозится управляемым гейтом на localforage.getItem.
test('buildNetDumpPayload: ждёт незавершённый рекордер перед чтением хранилища', async () => {
    let openGate;
    const gate = new Promise(resolve => { openGate = resolve; });
    const lf = globalThis.SillyTavern.libs.localforage;
    const originalGetItem = lf.getItem;
    let gated = false;
    lf.getItem = async (key) => {
        // Гейт только на первое чтение хранилища (внутри записи рекордера).
        if (!gated && key === LF_NETDUMP) { gated = true; await gate; }
        return originalGetItem(key);
    };
    try {
        const resp = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        const recording = recordFromFetch('https://api.x.com/v1/images/generations', { method: 'POST' }, resp, 1);
        let exported = false;
        const exportPromise = buildNetDumpPayload().then(payload => { exported = true; return payload; });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(exported, false, 'export ждёт работающий рекордер');
        openGate();
        await recording;
        const payload = await exportPromise;
        assert.equal(payload.meta.count, 1);
        assert.equal(payload.entries[0].kind, 'image');
        assert.match(payload.meta.note, /Metadata only/);
    } finally {
        lf.getItem = originalGetItem;
    }
});
