// @ts-check
// Контракт comfyui: чистые помощники адаптера, реестр, исключение ключа и
// сквозные прогоны адаптера с подделанным транспортом.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    COMFYUI_DEFAULT_WORKFLOW_TXT2IMG,
    COMFYUI_DEFAULT_WORKFLOW_IMG2IMG,
    aspectSize,
    substituteWorkflow,
    parseAndValidateWorkflow,
    mapLoadImageInputs,
    viewUrlFor,
    extractHistoryOutcome,
    summarizeWorkflow,
    extractWorkflowFromPng,
    readWorkflowFile,
    generateComfyUIImage,
} = await import('../src/providers/image-comfyui.js');
const { reducedRatio } = await import('../src/aspect-ratio.js');
const { requireInvocation } = await import('../src/providers/image-base.js');
const { getImageProviderAdapter, validateImageProviderInvocation } = await import('../src/image-provider-registry.js');
const { referenceEncoding } = await import('../src/dispatch-plan.js');

// ── Геометрия: точные бакеты, кратные 64 ──

test('aspectSize даёт точные соотношения, кратные 64, и дефолт', () => {
    const expected = {
        '1:1': [1024, 1024],
        '2:3': [1024, 1536],
        '3:2': [1536, 1024],
        '3:4': [768, 1024],
        '4:3': [1024, 768],
        '4:5': [1024, 1280],
        '5:4': [1280, 1024],
        '9:16': [576, 1024],
        '16:9': [1024, 576],
        '21:9': [1344, 576],
    };
    for (const [ratio, [w, h]] of Object.entries(expected)) {
        assert.deepEqual(aspectSize(ratio), { w, h }, ratio);
        // 21:9 — несократимый в URIS-таксономии, математически это 7:3;
        // aspectDeviates сравнивает численно, так что отклонения нет.
        const expectedReduced = ratio === '21:9' ? '7:3' : ratio;
        assert.equal(reducedRatio(w, h), expectedReduced, `${ratio}: пиксели дают запрошенное соотношение`);
        assert.equal(w % 64, 0, `${ratio}: ширина кратна 64`);
        assert.equal(h % 64, 0, `${ratio}: высота кратна 64`);
    }
    assert.deepEqual(aspectSize('мусор'), { w: 1024, h: 1024 });
    assert.deepEqual(aspectSize(undefined), { w: 1024, h: 1024 });
});

// ── Подстановка плейсхолдеров ──

test('substituteWorkflow: prompt подставляется последним и не переписывается сам', () => {
    const source = '{"6":{"inputs":{"text":"%prompt%"}},"3":{"inputs":{"seed":%seed%}}}';
    const { text, hasPromptPlaceholder, hasSeedPlaceholder } = substituteWorkflow(source, {
        modelId: 'm.safetensors',
        prompt: 'cat %seed% "quote"',
        seed: 42,
        width: 1024,
        height: 576,
    });
    const parsed = JSON.parse(text);
    assert.equal(parsed['6'].inputs.text, 'cat %seed% "quote"');
    assert.equal(parsed['3'].inputs.seed, 42);
    assert.equal(hasPromptPlaceholder, true);
    assert.equal(hasSeedPlaceholder, true);
});

test('substituteWorkflow: model в кавычках, width/height голые, отсутствие плейсхолдеров фиксируется', () => {
    const source = '{"4":{"inputs":{"ckpt_name":"%model%"}},"5":{"inputs":{"width":%width%,"height":%height%}}}';
    const { text, hasPromptPlaceholder, hasSeedPlaceholder } = substituteWorkflow(source, {
        modelId: 'dream"1.safetensors',
        prompt: 'x',
        seed: 7,
        width: 1024,
        height: 576,
    });
    const parsed = JSON.parse(text);
    assert.equal(parsed['4'].inputs.ckpt_name, 'dream"1.safetensors');
    assert.equal(parsed['5'].inputs.width, 1024);
    assert.equal(parsed['5'].inputs.height, 576);
    assert.equal(hasPromptPlaceholder, false);
    assert.equal(hasSeedPlaceholder, false);
});

// ── Разбор и валидация workflow ──

function substituted(workflowText) {
    return substituteWorkflow(workflowText, { modelId: 'm.safetensors', prompt: 'p', seed: 1, width: 1024, height: 1024 }).text;
}

test('parseAndValidateWorkflow: встроенные дефолты проходят (txt2img без LoadImage, img2img с одной)', () => {
    const txt = parseAndValidateWorkflow(substituted(COMFYUI_DEFAULT_WORKFLOW_TXT2IMG));
    assert.equal(txt.loadImageNodes.length, 0);
    assert.ok(txt.hasOutput);
    const img = parseAndValidateWorkflow(substituted(COMFYUI_DEFAULT_WORKFLOW_IMG2IMG));
    assert.equal(img.loadImageNodes.length, 1);
});

test('parseAndValidateWorkflow: битый JSON и UI-формат дают понятные ошибки', () => {
    assert.throws(() => parseAndValidateWorkflow('{нет'), error => error.code === 'COMFY_WORKFLOW_INVALID');
    const uiFormat = JSON.stringify({ nodes: [], links: [], version: 0.4 });
    assert.throws(
        () => parseAndValidateWorkflow(uiFormat),
        error => error.code === 'COMFY_NO_OUTPUT' && /Export \(API\)/.test(error.message),
    );
});

test('parseAndValidateWorkflow: граф без выходной ноды отклоняется', () => {
    const noOutput = '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"x"}}}';
    assert.throws(() => parseAndValidateWorkflow(noOutput), error => error.code === 'COMFY_NO_OUTPUT');
});

// ── Маппинг референс на ноды LoadImage ──

test('mapLoadImageInputs: по возрастанию ID нод, лишние референсы не расползаются', () => {
    const workflow = {
        '11': { class_type: 'LoadImage', inputs: { image: 'second.png' } },
        '10': { class_type: 'LoadImage', inputs: { image: 'first.png' } },
        '9': { class_type: 'SaveImage', inputs: { images: [] } },
    };
    mapLoadImageInputs(workflow, ['a.png', 'sub/b.png']);
    assert.equal(workflow['10'].inputs.image, 'a.png');
    assert.equal(workflow['11'].inputs.image, 'sub/b.png');
    mapLoadImageInputs(workflow, ['c.png']);
    assert.equal(workflow['10'].inputs.image, 'c.png');
    assert.equal(workflow['11'].inputs.image, 'sub/b.png');
});

// ── /view ──

test('viewUrlFor: кодирует все три параметра и хвост /api срезает', () => {
    assert.equal(
        viewUrlFor('http://127.0.0.1:8188/', { filename: 'a b.png', subfolder: '', type: 'output' }),
        'http://127.0.0.1:8188/view?filename=a+b.png&subfolder=&type=output',
    );
    assert.equal(
        viewUrlFor('http://127.0.0.1:8188/api', { filename: 'x.png', subfolder: 's/1', type: 'temp' }),
        'http://127.0.0.1:8188/view?filename=x.png&subfolder=s%2F1&type=temp',
    );
});

// ── История ──

test('extractHistoryOutcome: нет записи — ждём', () => {
    assert.deepEqual(extractHistoryOutcome({}, 'p1'), { status: 'pending' });
    assert.deepEqual(extractHistoryOutcome(null, 'p1'), { status: 'pending' });
});

test('extractHistoryOutcome: готовая запись отдаёт первую картинку', () => {
    const payload = {
        p1: {
            status: { status_str: 'success', completed: true, messages: [] },
            outputs: {
                '9': { images: [{ filename: 'uris_1_.png', subfolder: '', type: 'output' }] },
            },
        },
    };
    assert.deepEqual(extractHistoryOutcome(payload, 'p1'), {
        status: 'done',
        image: { filename: 'uris_1_.png', subfolder: '', type: 'output' },
    });
});

test('extractHistoryOutcome: ошибка ноды и прерывание превращаются в текст', () => {
    const payload = {
        p1: {
            status: { status_str: 'error', completed: false, messages: [
                ['execution_error', { node_type: 'KSampler', node_id: '3', exception_message: 'CUDA out of memory' }],
            ] },
            outputs: {},
        },
    };
    const outcome = extractHistoryOutcome(payload, 'p1');
    assert.equal(outcome.status, 'error');
    assert.match(outcome.message, /KSampler/);
    assert.match(outcome.message, /CUDA out of memory/);

    const interrupted = extractHistoryOutcome({
        p1: { status: { status_str: 'error', messages: [['execution_interrupted', {}]] }, outputs: {} },
    }, 'p1');
    assert.equal(interrupted.status, 'error');
});

test('extractHistoryOutcome: завершение без картинок — empty', () => {
    const payload = { p1: { status: { status_str: 'success', completed: true, messages: [] }, outputs: {} } };
    assert.deepEqual(extractHistoryOutcome(payload, 'p1'), { status: 'empty' });
});

// ── Реестр и исключение ключа ──

function baseInvocation() {
    return {
        endpoint: 'http://127.0.0.1:8188',
        apiKey: '',
        route: {
            contractVersion: 1,
            generationContract: 'comfyui',
            modelId: 'dream.safetensors',
            capabilities: {},
            transport: { bodyKind: 'json', directCors: 'preferred' },
        },
        request: { references: [] },
        transport: { requestJson: async () => {}, requestMultipart: async () => {}, downloadResult: async () => {} },
    };
}

test('comfyui зарегистрирован в реестре и не требует ключа', () => {
    assert.equal(typeof getImageProviderAdapter('comfyui'), 'function');
    const invocation = baseInvocation();
    assert.equal(typeof validateImageProviderInvocation(invocation), 'function');
    const required = requireInvocation(invocation);
    assert.equal(required.endpoint, 'http://127.0.0.1:8188');
    assert.equal(referenceEncoding('comfyui'), 'LoadImage (upload/image)');
});

test('другие контракты по-прежнему требуют ключ', () => {
    assert.throws(
        () => requireInvocation({ ...baseInvocation(), route: { ...baseInvocation().route, generationContract: 'pollinations-images' } }),
        error => error.code === 'POLLINATIONS_TOKEN_REQUIRED',
    );
});

// ── Сквозные прогоны адаптера с подделанным транспортом ──

const jsonResponse = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => 'application/json' },
});

const pngResponse = () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer,
    headers: { get: () => 'image/png' },
});

function fakeTransport({ historyPayload }) {
    const calls = [];
    return {
        calls,
        requestJson: async (url, options) => {
            calls.push(['json', url, options]);
            if (url.endsWith('/prompt')) return jsonResponse(200, { prompt_id: 'abc-123' });
            if (url.includes('/history/')) return jsonResponse(200, historyPayload());
            throw new Error(`unexpected url ${url}`);
        },
        requestMultipart: async (url) => {
            calls.push(['multipart', url]);
            return jsonResponse(200, { name: 'ref1.png', subfolder: '', type: 'input' });
        },
        downloadResult: async (url) => {
            calls.push(['download', url]);
            return pngResponse();
        },
    };
}

const doneHistory = () => ({
    'abc-123': {
        status: { status_str: 'success', completed: true, messages: [] },
        outputs: { '9': { images: [{ filename: 'uris_1_.png', subfolder: '', type: 'output' }] } },
    },
});

const customWithLoadImage = JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
    '10': { class_type: 'LoadImage', inputs: { image: 'start.png' } },
    '9': { class_type: 'SaveImage', inputs: { images: [] } },
});

test('адаптер: txt2img из дефолта — POST /prompt, поллинг, /view → dataUrl', async () => {
    const transport = fakeTransport({ historyPayload: doneHistory });
    const result = await generateComfyUIImage({
        ...baseInvocation(),
        apiKey: '',
        transport,
        connection: { timeoutMs: 5000 },
        request: { requestId: 'req-1', prompt: 'a cat "sits"', aspectRatio: '16:9', references: [] },
    });
    assert.equal(result.kind, 'dataUrl');
    assert.match(result.value, /^data:image\/png;base64,/);
    assert.deepEqual(result.warnings, []);
    const post = transport.calls.find(([kind, url]) => kind === 'json' && url === 'http://127.0.0.1:8188/prompt');
    assert.ok(post, 'POST /prompt должен уйти');
    const body = JSON.parse(post[2].body);
    assert.equal(body.prompt['4'].inputs.ckpt_name, 'dream.safetensors');
    assert.equal(body.prompt['6'].inputs.text, 'a cat "sits"');
    assert.equal(body.prompt['5'].inputs.width, 1024);
    assert.equal(body.prompt['5'].inputs.height, 576);
    assert.equal(Number.isInteger(body.prompt['3'].inputs.seed), true);
    assert.equal('prompt_id' in body, false);
    assert.ok(transport.calls.some(([kind, url]) => kind === 'download' && url.startsWith('http://127.0.0.1:8188/view?')));
    assert.equal(transport.calls.some(([kind, url]) => kind === 'multipart'), false);
});

test('адаптер: референсы загружаются и ложатся в LoadImage по порядку', async () => {
    const transport = fakeTransport({ historyPayload: doneHistory });
    const result = await generateComfyUIImage({
        ...baseInvocation(),
        transport,
        connection: { timeoutMs: 5000, workflowJson: customWithLoadImage },
        request: {
            requestId: 'req-2',
            prompt: 'a cat',
            aspectRatio: '1:1',
            references: [{ id: 'r1', name: 'ref', dataUrl: `data:image/png;base64,${btoa('png-bytes')}` }],
        },
    });
    assert.equal(result.kind, 'dataUrl');
    const upload = transport.calls.find(([kind, url]) => kind === 'multipart');
    assert.ok(upload && upload[1].endsWith('/upload/image'));
    const post = transport.calls.find(([kind, url]) => kind === 'json' && url.endsWith('/prompt'));
    const body = JSON.parse(post[2].body);
    assert.equal(body.prompt['10'].inputs.image, 'ref1.png');
});

test('адаптер: референсы без LoadImage и сверх количества нод отклоняются до отправки', async () => {
    // Пустой workflowJson переключил бы адаптер на встроенный img2img (там
    // LoadImage есть), поэтому «нет LoadImage» проверяется на кастомном графе.
    const customNoLoadImage = JSON.stringify({
        '6': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
        '9': { class_type: 'SaveImage', inputs: { images: [] } },
    });
    const transport = fakeTransport({ historyPayload: doneHistory });
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 5000, workflowJson: customNoLoadImage },
            request: {
                requestId: 'req-3', prompt: 'x', aspectRatio: '1:1',
                references: [{ id: 'r1', name: 'ref', dataUrl: `data:image/png;base64,${btoa('png')}` }],
            },
        }),
        error => error.code === 'COMFY_NO_LOADIMAGE',
    );
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 5000, workflowJson: customWithLoadImage },
            request: {
                requestId: 'req-4', prompt: 'x', aspectRatio: '1:1',
                references: [
                    { id: 'r1', name: 'a', dataUrl: `data:image/png;base64,${btoa('a')}` },
                    { id: 'r2', name: 'b', dataUrl: `data:image/png;base64,${btoa('b')}` },
                ],
            },
        }),
        error => error.code === 'COMFY_TOO_MANY_REFERENCES',
    );
    assert.equal(transport.calls.some(([kind]) => kind === 'multipart'), false);
    assert.equal(transport.calls.some(([kind, url]) => kind === 'json' && url.endsWith('/prompt')), false);
});

test('адаптер: workflow без %prompt% и без ключа — ошибки до постановки в очередь', async () => {
    const transport = fakeTransport({ historyPayload: doneHistory });
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 5000, workflowJson: '{"9":{"class_type":"SaveImage","inputs":{"images":[]}}}' },
            request: { requestId: 'req-5', prompt: 'x', aspectRatio: '1:1', references: [] },
        }),
        error => error.code === 'COMFY_PROMPT_MISSING',
    );
    assert.equal(transport.calls.some(([kind, url]) => kind === 'json' && url.endsWith('/prompt')), false);
});

test('адаптер: 400 с node_errors показывается по нодам', async () => {
    const transport = {
        calls: [],
        requestJson: async (url) => {
            if (url.endsWith('/prompt')) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => JSON.stringify({
                        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
                        node_errors: { '3': { node_type: 'KSampler', errors: [{ message: 'Value not in list', details: 'seed' }] } },
                    }),
                    headers: { get: () => 'application/json' },
                };
            }
            throw new Error(`unexpected url ${url}`);
        },
        requestMultipart: async () => {},
        downloadResult: async () => {},
    };
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 5000 },
            request: { requestId: 'req-6', prompt: 'x', aspectRatio: '1:1', references: [] },
        }),
        error => error.code === 'COMFY_PROMPT_REJECTED' && /KSampler/.test(error.message) && /Value not in list/.test(error.message),
    );
});

test('адаптер: очередь не сдвинулась до дедлайна — COMFY_JOB_TIMEOUT', async () => {
    const transport = fakeTransport({ historyPayload: () => ({}) });
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 30 },
            request: { requestId: 'req-7', prompt: 'x', aspectRatio: '1:1', references: [] },
        }),
        error => error.code === 'COMFY_JOB_TIMEOUT',
    );
});

test('адаптер: отсутствие %seed% в кастомном workflow — предупреждение', async () => {
    const transport = fakeTransport({ historyPayload: doneHistory });
    const result = await generateComfyUIImage({
        ...baseInvocation(),
        transport,
        connection: { timeoutMs: 5000, workflowJson: customWithLoadImage },
        request: { requestId: 'req-8', prompt: 'x', aspectRatio: '1:1', references: [] },
    });
    assert.equal(result.kind, 'dataUrl');
    assert.ok(result.warnings.some(w => w.feature === 'Seed'));
});

// ── summarizeWorkflow (У2: живой индикатор в карточке) ──

test('summarizeWorkflow: дефолтный txt2img — все плейсхолдеры на месте', () => {
    const s = summarizeWorkflow(COMFYUI_DEFAULT_WORKFLOW_TXT2IMG);
    assert.equal(s.ok, true);
    assert.equal(s.placeholders.prompt, true);
    assert.equal(s.placeholders.seed, true);
    assert.equal(s.placeholders.model, true);
    assert.equal(s.hasOutput, true);
    assert.equal(s.loadImageCount, 0);
    assert.equal(s.checkpointLoaderNoModel, false);
});

test('summarizeWorkflow: кастом без %seed%/%model%, но с LoadImage', () => {
    const s = summarizeWorkflow(customWithLoadImage);
    assert.equal(s.ok, true);
    assert.equal(s.placeholders.prompt, true);
    assert.equal(s.placeholders.seed, false);
    assert.equal(s.placeholders.model, false);
    assert.equal(s.hasOutput, true);
    assert.equal(s.loadImageCount, 1);
    assert.equal(s.checkpointLoaderNoModel, false);
});

test('summarizeWorkflow: чекпойнт-лоадер без %model% — флаг предупреждения', () => {
    const s = summarizeWorkflow('{"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"x.safetensors"}},"9":{"class_type":"SaveImage","inputs":{"images":[]}}}');
    assert.equal(s.ok, true);
    assert.equal(s.checkpointLoaderNoModel, true);
});

test('summarizeWorkflow: битый JSON — ok false, но чипы плейсхолдеров считаются по тексту', () => {
    const s = summarizeWorkflow('{"6": нет — "%prompt%"');
    assert.equal(s.ok, false);
    assert.ok(s.error);
    assert.equal(s.placeholders.prompt, true);
    assert.equal(s.hasOutput, null);
    assert.equal(s.loadImageCount, null);
});

// ── Загрузка workflow файлом: PNG-метаданные и JSON (У7) ──

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type, data) {
    const enc = new TextEncoder();
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(enc.encode(type), 4);
    chunk.set(data, 8);
    // CRC не проверяется экстрактором — оставляем нули.
    return chunk;
}

function textChunkPng(keyword, text) {
    const enc = new TextEncoder();
    const kw = enc.encode(keyword);
    const body = enc.encode(text);
    const data = new Uint8Array(kw.length + 1 + body.length);
    data.set(kw, 0);
    data.set(body, kw.length + 1);
    return pngChunk('tEXt', data);
}

function itextChunkPng(keyword, text, { compressed = false } = {}) {
    const enc = new TextEncoder();
    const kw = enc.encode(keyword);
    const body = enc.encode(text);
    const data = new Uint8Array(kw.length + 5 + body.length);
    data.set(kw, 0);
    data[kw.length + 1] = compressed ? 1 : 0; // compression flag
    data[kw.length + 2] = 0; // compression method
    // пустые language tag и translated keyword — по одному NUL каждый
    data.set(body, kw.length + 5);
    return pngChunk('iTXt', data);
}

function makePng(...chunks) {
    const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    out.set(pngSignature, 0);
    let offset = 8;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

const API_PROMPT_JSON = '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"%prompt%"}},"9":{"class_type":"SaveImage","inputs":{"images":[]}}}';
const UI_WORKFLOW_JSON = '{"nodes":[],"links":[],"version":0.4}';

test('extractWorkflowFromPng: чанк prompt (tEXt) отдаёт API-формат', () => {
    const png = makePng(pngChunk('IHDR', new Uint8Array(13)), textChunkPng('prompt', API_PROMPT_JSON), pngChunk('IEND', new Uint8Array(0)));
    const found = extractWorkflowFromPng(png);
    assert.equal(found.format, 'api');
    assert.equal(found.text, API_PROMPT_JSON);
});

test('extractWorkflowFromPng: iTXt с русским текстом (UTF-8) читается', () => {
    const json = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'кот в шляпе' } } });
    const png = makePng(itextChunkPng('prompt', json));
    const found = extractWorkflowFromPng(png);
    assert.equal(found.format, 'api');
    assert.equal(JSON.parse(found.text)['6'].inputs.text, 'кот в шляпе');
});

test('extractWorkflowFromPng: prompt важнее workflow; только workflow — это UI-формат', () => {
    const both = makePng(textChunkPng('workflow', UI_WORKFLOW_JSON), textChunkPng('prompt', API_PROMPT_JSON));
    assert.equal(extractWorkflowFromPng(both).format, 'api');
    const onlyUi = makePng(textChunkPng('workflow', UI_WORKFLOW_JSON));
    const found = extractWorkflowFromPng(onlyUi);
    assert.equal(found.format, 'ui');
    assert.equal(found.text, UI_WORKFLOW_JSON);
});

test('extractWorkflowFromPng: без метаданных, не-PNG и сжатый iTXt — null', () => {
    assert.deepEqual(extractWorkflowFromPng(makePng(pngChunk('IHDR', new Uint8Array(13)), pngChunk('IEND', new Uint8Array(0)))), { format: null, text: null });
    assert.deepEqual(extractWorkflowFromPng(new Uint8Array([1, 2, 3, 4])), { format: null, text: null });
    assert.deepEqual(extractWorkflowFromPng(makePng(itextChunkPng('prompt', API_PROMPT_JSON, { compressed: true }))), { format: null, text: null });
    // Обрезанный чанк не должен ронять разбор.
    const truncated = makePng(textChunkPng('prompt', API_PROMPT_JSON)).slice(0, 20);
    assert.deepEqual(extractWorkflowFromPng(truncated), { format: null, text: null });
});

function fakeFile(name, content, type = '') {
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    return {
        name,
        type,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

test('readWorkflowFile: PNG с чанком prompt отдаёт читаемый API-JSON', async () => {
    const png = makePng(textChunkPng('prompt', API_PROMPT_JSON));
    const loaded = await readWorkflowFile(fakeFile('ComfyUI_00001_.png', png, 'image/png'));
    assert.equal(loaded.format, 'api');
    assert.match(loaded.text, /\n {2}"/); // пересобран с отступами
    assert.equal(JSON.parse(loaded.text)['9'].class_type, 'SaveImage');
});

test('readWorkflowFile: PNG без метаданных — понятная ошибка', async () => {
    const png = makePng(pngChunk('IHDR', new Uint8Array(13)), pngChunk('IEND', new Uint8Array(0)));
    await assert.rejects(readWorkflowFile(fakeFile('plain.png', png)), /нет метаданных workflow/);
});

test('readWorkflowFile: JSON Export (API) — api; UI-формат «Save» — ui; битый/с плейсхолдерами — сырой текст', async () => {
    const api = await readWorkflowFile(fakeFile('wf.json', API_PROMPT_JSON));
    assert.equal(api.format, 'api');
    assert.match(api.text, /\n {2}"/);
    const ui = await readWorkflowFile(fakeFile('wf.json', UI_WORKFLOW_JSON));
    assert.equal(ui.format, 'ui');
    const withPlaceholders = '{"3":{"inputs":{"seed":%seed%}},"6":{"inputs":{"text":"%prompt%"}}}';
    const raw = await readWorkflowFile(fakeFile('wf.json', withPlaceholders));
    assert.equal(raw.format, 'unknown');
    assert.equal(raw.text, withPlaceholders, 'текст с голыми плейсхолдерами возвращается как есть');
});

// ── class_type-фолбэк в ошибках (У3) ──

test('extractHistoryOutcome: без node_type от сервера класс берётся из workflow', () => {
    const payload = { p1: { status: { status_str: 'error', messages: [['execution_error', { node_id: '3', exception_message: 'CUDA out of memory' }]] }, outputs: {} } };
    const outcome = extractHistoryOutcome(payload, 'p1', { '3': { class_type: 'KSampler' } });
    assert.match(outcome.message, /KSampler \[3\]/);
    assert.match(outcome.message, /CUDA out of memory/);
});

test('адаптер: COMFY_PROMPT_REJECTED без node_type от сервера — class_type из workflow', async () => {
    const transport = {
        calls: [],
        requestJson: async (url) => {
            if (url.endsWith('/prompt')) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => JSON.stringify({
                        error: { message: 'Prompt outputs failed validation' },
                        node_errors: { '3': { errors: [{ message: 'Value not in list', details: 'seed' }] } },
                    }),
                    headers: { get: () => 'application/json' },
                };
            }
            throw new Error(`unexpected url ${url}`);
        },
        requestMultipart: async () => {},
        downloadResult: async () => {},
    };
    await assert.rejects(
        generateComfyUIImage({
            ...baseInvocation(),
            transport,
            connection: { timeoutMs: 5000 },
            request: { requestId: 'req-9', prompt: 'x', aspectRatio: '1:1', references: [] },
        }),
        error => error.code === 'COMFY_PROMPT_REJECTED' && /KSampler \[3\]/.test(error.message),
    );
});
