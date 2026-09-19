# UR Image Studio — Надёжность доставки результатов генерации

> Дата: 2026-07-10 (пересмотрена; оригинал был про per-connection фичи)
> Контекст: расширение UR Image Studio v2 (`D:\VC CODE\UR Image Studio`)
> Цель: картинки, которые провайдер сгенерировал, доходят до галереи и не теряются.
> Статус: спецификация для реализации

---

## 1. Постановка задачи

Исходная проблема (цитата):

> Прокси говорит, что картинка сгенерирована. Может ли логика обработки ответа
> на запрос генерации быть нарушена? Куда деваются картинки, которые фактически
> были отправлены на сторону расширения, но не получены им? Может быть, стоит
> переработать логику сохранения результатов генерации?

Требование к расширению:

> Пользователь указал эндпоинт провайдера и API-ключ, выбрал модель — и расширение
> РАБОТАЕТ: отправляет корректные запросы и **не теряет картинки** в процессе.

Старая версия этой спеки была направлена на feature-build (per-connection таймаут,
CORS persistence, async polling, UI badges). После прослеживания полного пути
картинки оказалось, что проблема — в **надёжности доставки**, а не в нехватке фич.
Эта спека переписана под реальную задачу.

---

## 2. Диагноз: где именно теряются картинки

Полный путь картинки от провайдера до галереи:

```
Провайдер генерирует (✅ прокси видит «сгенерирована»)
    ↓
HTTP-ответ летит: провайдер → ST-прокси → браузер          ← МЕСТО ГИБЕЛИ #1
    ↓
extractImageFromResponseData(j) парсит JSON                  ← МЕСТО ГИБЕЛИ #2
    ↓
Если провайдер вернул URL → urlToDataUrl(url) скачивает      ← МЕСТО ГИБЕЛИ #3
    ↓
dataUrl возвращается в pipeline
    ↓
callWithRetry решает: повторять генерацию или нет            ← МЕСТО ГИБЕЛИ #4
    ↓
addToGallery / saveImageToFile
```

### Место гибели #1 — таймаут убивает тело ответа (`core.js:242`)

`fetchWithTimeout` стартует таймер **от начала запроса**, а не от получения
заголовков. GPT-image модели занимают 80–280 с. Хронология:

```
T=0с     запрос отправлен
T=100с   провайдер ДОРИСОВАЛ, шлёт 200 OK + тело (b64 ~2МБ)
T=120с   AbortController.abort() — тело обрезано посередине
```

Прокси на T=100с фиксирует «картинка сгенерирована» (ответ получен от апстрима).
Но браузер на T=120с убивает соединение. **Картинка существует у провайдера,
тело ответа не дошло до расширения.**

Дополнительно: `generationTimeout: 120000` есть в `defaultSettings` (`core.js:74`),
но **нигде не используется** — все провайдеры хардкодят `120000`.

### Место гибели #2 — провайдер игнорирует `response_format` (`openai.js:293`)

openai-провайдер шлёт `response_format: 'b64_json'`. Многие прокси это **игнорируют** и возвращают `url` на CDN вместо base64. Тогда срабатывает
ветка `dl[0]?.url` → `urlToDataUrl(dl[0].url)` — **второй fetch**. Картинка жива на
сервере провайдера, но расширение должно теперь скачать её отдельно.

### Место гибели #3 — скачивание URL падает (`openai.js:43`, `agnes.js:31`)

`urlToDataUrl` делает второй запрос с таймаутом **60с**:

```js
const resp = await autoFetch(url, {}, 60000);
```

CDN провайдера (`cdn.moe-atelier.site`, `platform-outputs.agnes-ai.space`) часто
блокирует прямой fetch (CORS). `autoFetch` ретраит через ST-прокси, и тут может:
не дойти за 60с; выпасть с сетевой ошибкой; прокси может быть выключен.

Ошибка пробрасывается наверх. **Картинка жива на сервере, URL был в ответе, но
расширение не сохранило его и не может скачать.**

### Место гибели #4 — callWithRetry сжигает деньги (`core.js:180`)

```js
if (!/429|503|502|504|timeout|Таймаут|network|.../i.test(e.message) || ...) break;
```

«Таймаут» **включён** в список retryable-ошибок. При `maxRetries > 0`:

```
Попытка 1: генерация 130с → таймаут 120с → деньги списаны, картинка потеряна
Попытка 2: генерация 130с → таймаут 120с → деньги списаны снова
Попытка 3: ... 
```

Три генерации, три списания, ноль картинок. Это самое разрушительное место —
оно превращает одну потерю в несколько.

> Примечание: `defaultSettings.maxRetries: 0`, поэтому по умолчанию retry не сработает.
> Но если пользователь поднял `maxRetries`, проблема активируется. И всё равно
> таймаут **не должен** быть retryable для image-генерации — повтор генерации
> повторно списывает деньги, в отличие от retry скачивания.

### Сводка по провайдерам

| Провайдер | Что возвращает | Где падает |
|---|---|---|
| openai (generations / edits / multimodal) | `b64_json` ИЛИ `url` | #1 таймаут обрезает тело; #2+#3 URL-ветка |
| gemini | inline base64 в JSON | #1 таймаут обрезает тело |
| agnes | `b64_json` ИЛИ `url` | #1; #3 |
| pollinations | бинарный blob | #1 таймаут обрезает blob |

Все провайдеры хардкодят таймаут `120000`, не используя `generationTimeout` из настроек.

---

## 3. Принципы дизайна

1. **Не повторять генерацию при таймауте.** Генерация = деньги. Таймаут ≠ повод
   повторить платный запрос.
2. **Не терять то, что уже получено.** URL из ответа сохраняется немедленно, до
   скачивания бинарника. Если скачивание упадёт — URL останется и картинку можно
   скачать позже.
3. **Retry — только для дешёвых операций.** Скачивание уже сгенерированной картинки
   по URL не тратит деньги провайдера → можно смело ретраить.
4. **Per-connection таймаут.** Gemini хватает 30с, GPT-image нужно 300с. Глобальный
   таймаут либо режет медленные, либо заставляет ждать быстрые.
5. **Прозрачность для пользователя.** Пользователь видит, что идёт генерация и
   сколько осталось. Не видит — внутренних retry/URL/extraction деталей.
6. **Graceful degradation.** Никаких обязательных серверных компонентов. Если
   ST-прокси выключен — расширение работает для прямых хостов и честно сообщает
   ошибку для хостов за CORS.

---

## 4. Модель данных

### 4.1 Поле `timeoutMs` в объекте коннекта

```js
{
  id, kind: 'image', name, apiType, endpoint, model,
  timeoutMs: number,            // НОВОЕ: таймаут генерации для этого коннекта
  providerOptions: { ... },     // существующее
  availableModels, lastFetch, secretId,
}
```

Дефолт при миграции: `300000` (5 минут). Обоснование: 120с мало для GPT-image,
300с покрывает подавляющее большинство генераций. Не бесконечность — чтобы
зависший запрос не висел вечно.

Хранение: `uris_connections` в localforage, как и раньше.

### 4.2 Pending image references (`uris_pending_images`)

Сохранённые, но не скачанные результаты генерации. Ключевая идея: URL (или dataUrl)
из ответа провайдера живёт в localforage и переживает любой сбой скачивания.

```js
// localforage key: 'uris_pending_images'  → Array
[
  {
    id: string,                  // uid
    connId: string,              // для контекста/UI
    chatId: string,              // для добавления в нужную галерею
    sourceMsgId: number | null,
    kind: 'url' | 'dataUrl',     // что у нас есть
    value: string,               // URL или data:image/...;base64,...
    instruction: { prompt, style, aspectRatio, imageSize },  // для записи в галерею
    refsSig: string,
    status: 'pending' | 'downloading' | 'done' | 'failed',
    createdAt: string,           // ISO timestamp
    attempts: number,            // сколько раз пытались скачать
  }
]
```

TTL: 7 дней (`createdAt` старше → удаляем). `status: 'failed'` после N попыток
(3) — остаётся в списке для ручного retry через UI, но автопроб не делаем.

### 4.3 Что НЕ входит в модель (out of scope)

- Async job polling (`job_id` + `polling_url`) — отдельная фича для будущего.
- Persisted CORS-стратегии хостов — отдельная фича. CORS-путь остаётся
  as-is (сессионный кэш `_hostStrategy` в `proxy.js`).
- UI badges (путь/таймаут/async-статус) — не нужны для надёжности доставки.

---

## 5. Изменения логики

### 5.1 Retry-политика: убрать «Таймаут» из retryable (`core.js:180`)

**Сейчас:**
```js
if (!/429|503|502|504|timeout|Таймаут|network|Failed to fetch|CORS|недоступн/i.test(e.message)
    || attempt === s.maxRetries) break;
```

**Стало:** таймаут больше не ретраится для генерации. Таймаут — это не временный
сбой, это «слишком долго». Повтор генерации = повторная трата денег.

Два варианта реализации:

**Вариант A (минимальный):** убрать `Таймаут` и `timeout` из регэкспа.
Но тогда 502/503 (которые часто связаны с network) тоже перестанут ретраиться —
это нежелательно для text-LLM stage1.

**Вариант B (рекомендуемый):** разделить retry-политику по стадиям.

`callWithRetry` получает опцию `mode`:

```js
export async function callWithRetry(fn, label, mode = 'network') {
    // mode === 'generation' → НЕ ретраить таймаут (деньги)
    // mode === 'network'    → ретраить 429/503/network, но НЕ таймаут
    //                       (timeout убираем из обеих — см. обоснование)
    const s = state.settings;
    let lastErr;
    for (let attempt = 0; attempt <= s.maxRetries; attempt++) {
        try { return await fn(attempt); }
        catch (e) {
            lastErr = e;
            log(`${label} попытка ${attempt + 1}: ${e.message}`);
            const retryable = /429|503|502|504|network|Failed to fetch|CORS|недоступн/i;
            if (!retryable.test(e.message) || attempt === s.maxRetries) break;
            await new Promise(r => setTimeout(r, s.retryDelay * Math.pow(2, attempt)));
        }
    }
    throw lastErr;
}
```

Обоснование полного удаления «Таймаут»: даже для network-режима (text-LLM) повтор
по таймауту обычно не помогает — LLM либо отвечает за разумное время, либо завис.
А для генерации повтор гарантированно тратит деньги.

**Вызов в `image-api.js:100`:**
```js
return callWithRetry(async (attempt) => { ... }, 'image-api', 'generation');
```

### 5.2 Per-connection таймаут

**Цель:** пробросить `conn.timeoutMs` во все провайдеры вместо хардкода `120000`.

#### 5.2.1 `image-api.js` — проброс в profile

В `generateImage` (`image-api.js:84`) добавить в profile:

```js
const profile = {
    ...,
    timeoutMs: conn.timeoutMs ?? state.settings?.generationTimeout ?? 300000,
};
```

#### 5.2.2 Все провайдеры — использовать `p.timeoutMs`

Заменить все хардкоды `120000` на `p.timeoutMs ?? 300000`:

| Файл | Строки | Текущее |
|---|---|---|
| `providers/openai.js` | 139, 205, 251, 313 | `120000` |
| `providers/gemini.js` | 87, 146 | `120000` |
| `providers/agnes.js` | 77 | `120000` |
| `providers/pollinations.js` | 112 | `120000` |

`fetchWithTimeout` в `core.js:242` дефолт оставить `120000` как last-resort, но
провайдеры всегда передают явное значение.

#### 5.2.3 Дефолт `generationTimeout` поднять до 300000 (`core.js:74`)

```js
generationTimeout: 300000,  // было 120000
```

Это global fallback, если у коннекта нет `timeoutMs`. 300с покрывает GPT-image.

### 5.3 Защита URL: сохранение до скачивания

**Цель:** если провайдер вернул URL, сохраняем его в `uris_pending_images`
**немедленно**, до попытки скачать. Если скачивание упадёт — URL не потерян.

#### 5.3.1 Новый модуль `src/image-recovery.js`

```js
// @ts-check
/**
 * Восстановление результатов генерации: сохранение URL/dataUrl до скачивания,
 * отложенный retry скачивания, возобновление при старте.
 *
 * Жизненный цикл pending image:
 *   generation → [extract url] → savePending → download → addToGallery → remove
 *                                              ↑ упало     ↑ отдельно retryable
 */
import { log, warn, uid } from './core.js';
import { addToGallery, saveImageToFile } from './storage.js';

function lf() { return SillyTavern.libs.localforage; }
const KEY = 'uris_pending_images';
const TTL = 7 * 24 * 60 * 60 * 1000; // 7 дней
const MAX_ATTEMPTS = 3;

async function listPending() {
    const arr = await lf().getItem(KEY);
    return Array.isArray(arr) ? arr : [];
}
async function writePending(arr) { await lf().setItem(KEY, arr); }

/** Сохранить URL/dataUrl немедленно, до скачивания. Возвращает id для трекинга. */
export async function savePendingImage({ connId, chatId, sourceMsgId, url, dataUrl, instruction, refsSig }) {
    const item = {
        id: uid(),
        connId, chatId, sourceMsgId,
        kind: url ? 'url' : 'dataUrl',
        value: url || dataUrl,
        instruction, refsSig,
        status: 'pending',
        createdAt: new Date().toISOString(),
        attempts: 0,
    };
    const arr = await listPending();
    arr.push(item);
    await writePending(arr);
    log('image-recovery: сохранён pending', item.id, item.kind);
    return item.id;
}

/** Скачать один pending → addToGallery → удалить из pending. */
export async function processPending(id, urlToDataUrl) {
    const arr = await listPending();
    const item = arr.find(x => x.id === id);
    if (!item) return null;
    if (item.status === 'done') return null;

    item.status = 'downloading';
    item.attempts++;
    await writePending(arr);

    try {
        const dataUrl = item.kind === 'dataUrl' ? item.value : await urlToDataUrl(item.value);

        // Опциональное сохранение в ST-галерею (как в pipeline.js).
        let stGalleryPath = null;
        // (логика galleryMode — пробросить из state.settings, см. §5.4)

        const entry = await addToGallery(item.chatId, {
            src: stGalleryPath || dataUrl,
            prompt: item.instruction?.prompt,
            style: item.instruction?.style,
            aspectRatio: item.instruction?.aspectRatio,
            imageSize: item.instruction?.imageSize,
            refsSig: item.refsSig,
            sourceMsgId: item.sourceMsgId,
            saved: !!stGalleryPath,
            stGalleryPath,
        });

        await removePending(id);
        window.dispatchEvent(new CustomEvent('uris:gallery-updated',
            { detail: { chatId: item.chatId, msgId: item.sourceMsgId } }));
        log('image-recovery: pending обработан', id);
        return entry;
    } catch (e) {
        warn('image-recovery: скачивание не удалось', id, e.message);
        const fresh = await listPending();
        const cur = fresh.find(x => x.id === id);
        if (cur) {
            cur.status = cur.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
            await writePending(fresh);
        }
        throw e;
    }
}

async function removePending(id) {
    const arr = await listPending();
    await writePending(arr.filter(x => x.id !== id));
}

/** При старте расширения: почистить устаревшие + запустить скачивание pending. */
export async function resumePendingImages(urlToDataUrl) {
    let arr = await listPending();
    const now = Date.now();
    const before = arr.length;
    arr = arr.filter(x => now - new Date(x.createdAt).getTime() < TTL);
    if (arr.length !== before) await writePending(arr);

    const actionable = arr.filter(x => x.status === 'pending');
    log('image-recovery: resume', actionable.length, 'pending images');
    for (const item of actionable) {
        try { await processPending(item.id, urlToDataUrl); }
        catch { /* уже залогировано в processPending */ }
    }
}

/** Экспорт pending для UI (раздел «Незавершённые генерации»). */
export async function getPendingImages() {
    const arr = await listPending();
    return arr.filter(x => x.status !== 'done');
}
```

#### 5.3.2 Интеграция в провайдеры

Каждый провайдер, у которого есть URL-ветка (`openai.js`, `agnes.js`), меняет
обработку ответа:

**Было** (`openai.js:74-83`):
```js
async function extractImageFromResponseData(j) {
    const dl = j?.data || [];
    if (!dl.length) {
        if (j?.url) return await urlToDataUrl(j.url);
        throw new Error('Image API: нет данных в ответе');
    }
    if (dl[0]?.b64_json) return `data:image/png;base64,${dl[0].b64_json}`;
    if (dl[0]?.url) return await urlToDataUrl(dl[0].url);
    throw new Error('Image API: нет данных в ответе');
}
```

**Проблема:** `urlToDataUrl` вызывается inline. Если падает — URL потерян, т.к.
ошибка пробрасывается до pipeline, и нигде URL не сохранялся.

**Стало:** экстрактор возвращает не dataUrl, а **описание результата**:

```js
/**
 * Извлечь результат из ответа провайдера.
 * Возвращает { kind: 'dataUrl', value } или { kind: 'url', value }.
 * НЕ скачивает URL — скачивание отдельная стадия с retry.
 */
function extractImageResult(j) {
    const dl = j?.data || [];
    if (!dl.length) {
        if (j?.url) return { kind: 'url', value: j.url };
        throw new Error('Image API: нет данных в ответе');
    }
    if (dl[0]?.b64_json) return { kind: 'dataUrl', value: `data:image/png;base64,${dl[0].b64_json}` };
    if (dl[0]?.url) return { kind: 'url', value: dl[0].url };
    throw new Error('Image API: нет данных в ответе');
}
```

`urlToDataUrl` выносится в общий модуль (см. §5.4) и используется только на стадии
скачивания, отдельно от экстракции.

### 5.4 Универсальный модуль скачивания `src/image-download.js`

Сейчас `urlToDataUrl` дублирован в `openai.js:43` и `agnes.js:31` — идентичные
функции. Вынести в один модуль с retry:

```js
// @ts-check
/**
 * Скачивание URL → dataUrl. Не тратит деньги провайдера (картинка уже
 * сгенерирована), поэтому retry безопасен.
 */
import { autoFetch } from './proxy.js';

const MAX_DOWNLOAD_RETRIES = 3;
const DOWNLOAD_TIMEOUT = 90000;  // 90с — больше текущих 60с

async function fetchToDataUrl(url, signal) {
    const resp = await autoFetch(url, {}, DOWNLOAD_TIMEOUT);
    if (!resp.ok) throw new Error(`Загрузка URL не удалась (HTTP ${resp.status})`);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Не удалось прочитать blob'));
        r.readAsDataURL(blob);
    });
}

/** С retry — скачивание дешёвое, можно повторять. */
export async function urlToDataUrl(url, signal) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        try { return await fetchToDataUrl(url, signal); }
        catch (e) {
            lastErr = e;
            if (attempt < MAX_DOWNLOAD_RETRIES) {
                await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
            }
        }
    }
    throw lastErr;
}
```

`openai.js` и `agnes.js` импортируют из этого модуля вместо своих копий.

### 5.5 Универсальный экстрактор ответа

Разные провайдеры и прокси возвращают результат в разных форматах. В `pollAsyncJob`
(если будущий async) и в URL-ветках экстрактор должен покрывать варианты.

**Объединённый экстрактор** (применяется к JSON-ответу generational endpoint):

```js
function extractImageResult(j) {
    const dl = j?.data || [];
    // OpenAI-style: data[0].b64_json или data[0].url
    if (dl[0]?.b64_json) return { kind: 'dataUrl', value: `data:image/png;base64,${dl[0].b64_json}` };
    if (dl[0]?.url)     return { kind: 'url', value: dl[0].url };
    // Top-level url (некоторые прокси)
    if (j?.url)         return { kind: 'url', value: j.url };
    // BFL-style: result.sample (для будущего async)
    if (j?.result?.sample) return { kind: 'url', value: j.result.sample };
    // FalAI-style: output.images[0].url
    if (j?.output?.images?.[0]?.url) return { kind: 'url', value: j.output.images[0].url };
    throw new Error('Image API: нет данных в ответе');
}
```

Gemini и pollinations возвращают данные иначе (inline base64 / blob) — для них
экстрактор не нужен, но таймаут (§5.2) и retry-политика (§5.1) применяются.

### 5.6 Поток генерации с восстановлением

Обновлённый `image-api.js` → провайдер возвращает результат, pipeline решает:

```js
// В провайдере (openai.js generateImageGenerations):
const j = await resp.json();
const result = extractImageResult(j);
// result: { kind: 'dataUrl', value } или { kind: 'url', value }
return result;   // НЕ скачиваем URL здесь

// В pipeline.js runStage2:
const result = await generateImage(...);  // теперь { kind, value }

// Немедленно сохраняем — что бы ни случилось дальше, результат не потерян.
const pendingId = await savePendingImage({
    connId, chatId, sourceMsgId: msgId,
    url: result.kind === 'url' ? result.value : null,
    dataUrl: result.kind === 'dataUrl' ? result.value : null,
    instruction, refsSig,
});

// Если уже dataUrl — сразу в галерею. Если url — скачиваем (с retry в image-download).
if (result.kind === 'dataUrl') {
    await processPending(pendingId);  // просто addToGallery
} else {
    onStatus?.('Загрузка изображения...');
    await processPending(pendingId, urlToDataUrl);  // скачивание с retry
}
```

Ключевое свойство: **после `savePendingImage` картинка не может быть потеряна** —
даже если ST упадёт, даже если пользователь закроет вкладку. После перезагрузки
`resumePendingImages` дочитает список и докачает.

### 5.7 Возобновление при старте

В `onActivate` расширения (там, где сейчас грузятся коннекты):

```js
import { resumePendingImages } from './image-recovery.js';
import { urlToDataUrl } from './image-download.js';

// ...после загрузки коннектов...
resumePendingImages(urlToDataUrl).catch(e => warn('resume pending failed:', e.message));
```

Не блокируем активацию — восстановление в фоне.

---

## 6. Миграция существующих коннектов

В `connections.js` `listConnections` (`connections.js:94`) дополняем каждый коннект:

```js
export async function listConnections() {
    const arr = await lf().getItem(LF_CONNECTIONS);
    const out = Array.isArray(arr) ? arr : [];
    return out.map(c => ({
        ...c,
        timeoutMs: c.timeoutMs ?? state.settings?.generationTimeout ?? 300000,
        providerOptions: c.providerOptions || {},
    }));
}
```

`timeoutMs` также добавить в whitelist `saveConnection` (`connections.js:145`):

```js
for (const k of ['kind', 'name', 'apiType', 'endpoint', 'model', 'timeoutMs',
                  'availableModels', 'lastFetch', 'secretId', 'providerOptions']) {
```

Старые коннекты без `timeoutMs` получают дефолт 300000 через миграцию. Без breaking changes.

---

## 7. UI изменения

### 7.1 Поле таймаута в карточке коннекта

В `tab-api.js` `imageConnFields` (`tab-api.js:304`), после поля модели:

```html
<div class="uris-row"><label>Таймаут (сек)</label>
    <input type="number" class="text_pole uris-timeout" min="30" max="600" step="30"
           value="${Math.round((p.timeoutMs ?? 300000) / 1000)}"
           title="Сколько ждать ответа от провайдера. GPT-image нужно ~300с, Gemini хватает 30с."></div>
```

Храним `timeoutMs` в мс; UI показывает в секундах для читаемости. `collectConnCard`
конвертирует обратно: `timeoutMs: parseInt(input.value, 10) * 1000`.

Глобальная настройка `generationTimeout` остаётся как fallback (используется, только
если у коннекта нет `timeoutMs`). Вкладка «Настройки» — можно оставить как есть.

### 7.2 Что НЕ меняем в UI

- CORS-плашку не трогаем (persisted CORS-стратегии — out of scope).
- Async badges не добавляем.
- Глобальные настройки retry не выносим в UI (оставляем `maxRetries: 0` дефолтом).

### 7.3 Опционально: индикатор «незавершённые генерации»

Минимальный статус в карточке расширения или тултипе:

> ⏳ Незавершённых загрузок: N

Если N > 0, показываем кнопку «Докачать». Реализация через `getPendingImages()`.
Это nice-to-have, не блокирует основную задачу.

---

## 8. Архитектура изменений

### 8.1 Изменённые файлы

| Файл | Что меняется |
|---|---|
| `src/core.js` | `callWithRetry` — убрать «Таймаут» из retryable, опция `mode`; дефолт `generationTimeout` 300000. |
| `src/image-api.js` | Передача `timeoutMs` в profile; вызов `callWithRetry(..., 'generation')`. |
| `src/connections.js` | Миграция `timeoutMs` в `listConnections`; whitelist в `saveConnection`. |
| `src/providers/openai.js` | `p.timeoutMs` вместо хардкода; экстрактор возвращает `{kind, value}`; импорт `urlToDataUrl` из `image-download.js`. |
| `src/providers/gemini.js` | `p.timeoutMs` вместо хардкода. |
| `src/providers/agnes.js` | `p.timeoutMs`; экстрактор `{kind, value}`; импорт `urlToDataUrl`. |
| `src/providers/pollinations.js` | `p.timeoutMs`. |
| `src/pipeline.js` | `savePendingImage` → `processPending` flow в `runStage2`. |
| `src/ui/tab-api.js` | Поле таймаута в карточке коннекта; `collectConnCard`. |
| `index.js` (или точка активации) | `resumePendingImages` при старте. |

### 8.2 Новые файлы

| Файл | Назначение |
|---|---|
| `src/image-recovery.js` | Pending images: сохранение URL до скачивания, retry, resume при старте. |
| `src/image-download.js` | Универсальный `urlToDataUrl` с retry (вынесен из дублей в openai/agnes). |

### 8.3 Новые тесты

| Файл | Что тестирует |
|---|---|
| `tests/image-recovery.test.js` | savePending → processPending → removePending; resume при старте; TTL; max attempts → failed. |
| `tests/image-download.test.js` | retry на сетевой сбой; успех после N попыток; timeout. |
| `tests/connections-timeout.test.js` | Миграция `timeoutMs`; дефолт 300000; whitelist в saveConnection. |
| `tests/retry-policy.test.js` | `callWithRetry('generation')` не ретраит таймаут; ретраит 503. |

Обновить существующие:
- `tests/providers.test.js` — экстрактор возвращает `{kind, value}` вместо dataUrl.
- `tests/providers/openai-refs.test.js` — то же.

---

## 9. Фазы реализации

### Фаза 1 — Прекратить терять картинки (критично)

Цель: закрыть все 4 места гибели. Можно релизить без UI-полей.

1. `callWithRetry` — убрать «Таймаут» из retryable (§5.1). **1 строка + тест.**
2. Поднять дефолт `generationTimeout` до 300000 (§5.2.3). **1 строка.**
3. Все провайдеры: `p.timeoutMs ?? 300000` вместо хардкода 120000 (§5.2.2).
4. Проброс `timeoutMs` в `image-api.js` profile (§5.2.1).
5. `image-download.js` с retry (§5.4).
6. Экстрактор `{kind, value}` в openai + agnes (§5.3.2, §5.5).
7. `image-recovery.js` + интеграция в pipeline (§5.3, §5.6).
8. `resumePendingImages` при старте (§5.7).

После Фазы 1: картинки не теряются ни при таймауте, ни при падении скачивания,
ни при перезагрузке. Retry больше не сжигает деньги.

### Фаза 2 — Per-connection таймаут в UI

Цель: пользователь настраивает таймаут под конкретный провайдер.

1. Миграция `timeoutMs` в connections (§6).
2. Поле таймаута в карточке коннекта (§7.1).
3. Опц.: индикатор незавершённых загрузок (§7.3).

После Фазы 2: Gemini-коннект с таймаутом 30с и GPT-image-коннект с таймаутом 300с
сосуществуют без конфликтов.

> Рекомендация: Фаза 1 — это 90% пользы и решает исходную жалобу. Фаза 2 — удобство.

---

## 10. Риски и ограничения

| Риск | Митигация |
|---|---|
| `timeoutMs` слишком большой → пользователь ждёт зависший запрос 10 мин |上限 600с в UI; пользователь видит статус и может отменить (Stop). |
| Pending images накапливаются при хроническом сбое скачивания | MAX_ATTEMPTS=3 → status `failed`; TTL 7 дней; UI показывает счётчик. |
| URL провайдера истекает (signed URL со сроком жизни) | Retry в пределах TTL; при истёкшем URL — `failed`, не зацикливаем. |
| `processPending` при старте делает запросы, которые пользователь не инициировал | Только для `status: 'pending'`; `failed` не трогаем автоматически. |
| Миграция `timeoutMs` ломает старые коннекты | Дефолт через `??` — старые коннекты получают 300000, структура не ломается. |
| `callWithRetry('generation')` не ретраит 502/503 от прокси | 502/503 ретраятся (они в списке). Не ретраится только таймаут. |

---

## 11. Что НЕ делаем (out of scope)

Эти элементы были в старой спеке, но не относятся к надёжности доставки. Вынесены
в отдельные будущие спеки, чтобы не размывать фокус:

- **Async job polling** (`job_id` + `polling_url`). Это отдельный механизм для
  провайдеров, которые его поддерживают (TheRouter, BFL). Независим от надёжности
  доставки синхронных ответов. Если будет реализован — `image-recovery.js` уже
  готов хранить pending jobs, достаточно добавить polling-стадию перед скачиванием.
- **Persisted CORS-стратегии хостов** (localforage). Текущий сессионный кэш
  `_hostStrategy` работает; persist — улучшение UX, не надёжности.
- **UI badges** (путь/таймаут/async-статус). Поле таймаута в карточке (§7.1)
  достаточно для пользователя; badges — избыточны.
- **Серверный плагин-релей** (`/api/plugins/...`). Решает таймаут радикально, но
  требует `enableServerPlugins` и установки плагина — это другой уровень деплоя.
  Текущая спека решает проблему без серверных компонентов.

---

## 12. Критерии готовности

### Фаза 1
- [ ] `callWithRetry` не ретраит ошибку «Таймаут (...)» для генерации.
- [ ] `generationTimeout` дефолт = 300000.
- [ ] Все провайдеры используют `p.timeoutMs` вместо хардкода 120000.
- [ ] `image-download.js` ретраит скачивание до 3 раз.
- [ ] Экстракторы openai/agnes возвращают `{kind, value}`, не скачивают inline.
- [ ] `image-recovery.js` сохраняет URL/dataUrl в localforage до скачивания.
- [ ] При падении скачивания — URL остаётся в `uris_pending_images`.
- [ ] `resumePendingImages` при старте дочитывает незавершённые.
- [ ] Тест: провайдер вернул URL → скачивание упало → URL в pending → старт → картинка в галерее.
- [ ] Тест: таймаут генерации → НЕ повторяется (1 upstream-запрос, не maxRetries+1).

### Фаза 2
- [ ] `conn.timeoutMs` мигрируется с дефолтом 300000.
- [ ] Поле «Таймаут (сек)» в карточке коннекта.
- [ ] `collectConnCard` сохраняет `timeoutMs` в мс.
- [ ] Тест: Gemini-коннект с timeoutMs=30000 → провайдер получает таймаут 30с.
