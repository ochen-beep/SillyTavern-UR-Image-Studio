# Runbook: проверка внешнего моста URIS (тест-сборка)

Экспериментальная поверхность `globalThis.URIS` (см. запись 2026-09-10 в
`CHANGELOG.md`). Есть три пути проверки: **вкладка «Мост»** (лаборатория
пайплайна: шаблоны, референсы, резолвер — включается в Настройках), **панель в
настройках** (краткий тумблер) и **консоль DevTools** (сценарии, которых нет в
UI — очередь, события, lifecycle).

## Путь 0: вкладка «Мост» — весь пайплайн на поверхности моста

Настройки → «Показывать вкладку „Мост"» → в шапке окна появится вкладка.

1. **Шаблон → промпт**: выбрать шаблон URIS (или «без шаблона»), ввести
   произвольный текст сцены (макросы `{{char}}`/`{{user}}` разворачиваются),
   включить «Резолвер сцены», нажать «Построить промпт». Это настоящий Stage 1
   (платный текстовый запрос) над текстом, который НЕ является сообщением чата.
   Ниже — готовый промпт и строка, кого резолвер сопоставил с пулом чата.
2. **Генерация как внешнее**: готовый промпт уже в поле; отметить референсы
   пула (уйдут как `references: [{refId}]`), включить «Авто-подбор по промпту»
   (резолвер Stage 2 — `useSceneRefs`), выбрать формат/соединение, нажать
   «Сгенерировать». Превью + строка `Готово [ext_…]: W×H · imagePath`.
3. **Читающая поверхность (0.9.6)** — нижние секции вкладки: «Возможности
   соединения» (`getCapabilities`), «Триггер-профили» (`listTriggers`),
   «Галерея caller'а» (`listGallery`, удаление через `removeCard` — кнопка ×),
   «Recovery» (`listPending`). Галерея и recovery перекрашиваются сами на
   события `gallery:added/removed` — после генерации карточка появляется без
   ручного «Обновить». Ошибки показываются как `[CODE · category · повторимо]`.
4. Смысл: потребителю (Offstage и т.п.) не нужно повторять пайплайн URIS —
   мост отдаёт и «построй промпт по шаблону со сценой», и «сгенерируй с
   авто-подбором референсов» тем же вызовом, что и голую генерацию.

## Путь 1: панель «Настройки → Внешний мост» (без консоли, мобильный OK)

1. Перезагрузить SillyTavern. Открыть чат с персонажем; убедиться, что ручная
   генерация в URIS работает (иначе мосту не в чем).
2. Открыть окно URIS → вкладка **Настройки** → секция **«Внешний мост
   (эксперимент)»**. Тумблер «Разрешить генерацию другим расширениям» включён
   по умолчанию; панель сама показывает статус (`ready`, `accepting`,
   соединение чата, что в работе).
3. Промпт подставлен дефолтный; при желании поменять промпт/формат/соединение
   (пустое = «как в текущем чате») и нажать **«Сгенерировать как внешнее»**.
   Кнопка становится «Отменить» на время полёта (это настоящий AbortSignal).
4. Результат: превью прямо в панели + строка `Готово [ext_bridge-test_…]:
   W×H · imagePath`. Картинка появится в галерее URIS как обычная карточка с
   `provenance.requestId = ext_bridge-test_…`.
5. Ошибки показываются в той же строке с кодом: `[NO_CONNECTION]` — выберите
   соединение в селекте; `[INVALID_PARAMS]` — пустой промпт и т.п.

Панель вызывает ту же публичную поверхность (`globalThis.URIS` через
`getBridge()`), что и стороннее расширение, — это честный тест моста, а не
обходной путь.

## Путь 2: консоль DevTools

## Предусловия

- URIS включён, на текущем чате выбрано рабочее image-соединение (вкладка
  «Генерация» умеет генерировать вручную).
- DevTools → Console. Все сниппеты — top-level `await` (консоль ST это умеет).

## A. Детект и готовность

```js
typeof URIS                    // 'object' — мост опубликован
await URIS.ready               // разрешится после полного init
await URIS.getStatus()         // { enabled, ready, accepting, connection: {id,label,modelId,ready}, active: [] }
await URIS.listConnections()   // sanitized: {id,label,modelId,ready} — endpoint/ключей здесь нет
```

Ожидание: `connection` совпадает с профилем текущего чата; `ready: true`.

## B. Первая headless-генерация

```js
const res = await URIS.generate(
    { prompt: 'a cozy reading nook by a rain-streaked window, warm lamp light',
      aspectRatio: '3:2' },
    { caller: 'console-test', onStatus: s => console.log('status:', s) },
);
res;                            // { requestId: 'ext_console-test_…', cardId, imagePath, width, height, warnings }
```

Проверки:

1. `res.imagePath` начинается с `user/images/UR%20Image%20Studio/…` и
   открывается: `open(res.imagePath)` или `<img src>` ниже.
2. Картинка появилась в галерее URIS; в карточке `provenance.requestId`
   начинается с `ext_console-test_`.
3. Диагностика: `bridge-generate-start` / `bridge-generate-end` с
   `details.caller === 'console-test'`.

```js
const img = document.createElement('img');
img.src = res.imagePath; img.style.cssText = 'position:fixed;right:8px;bottom:8px;width:220px;z-index:99999';
document.body.append(img);
img.decode().then(() => console.log('OK', img.naturalWidth + 'x' + img.naturalHeight));
```

Поведенческая проверка `<img src=native-path>` — это ровно то, как потребитель
(Offstage/GlassPhone) покажет результат у себя.

## C. Ошибка соединения и структурные коды

```js
try {
    await URIS.generate({ prompt: 'x' }, { caller: 'console-test', /* connectionId которого нет */ });
} catch (e) { console.log(e.name, e.code, e.message); }
// без настроенного чата ожидание: UrisBridgeError NO_CONNECTION
```

```js
URIS.generate({ prompt: '' }, { caller: 'console-test' });                       // INVALID_PARAMS
URIS.generate({ prompt: 'x' }, { caller: 'has space' });                          // INVALID_CALLER
URIS.generate({ prompt: 'x' });                                                   // INVALID_CALLER (caller обязателен)
URIS.generate({ prompt: 'x', aspectRatio: '7:3' }, { caller: 'c' });              // INVALID_PARAMS
```

## D. Отмена (главное отличие от «импорта чужого pipeline.js»)

```js
const p = URIS.generate({ prompt: 'detailed fantasy cityscape, ultra wide' }, { caller: 'console-test' });
const { requestId } = await new Promise(r => URIS.on('generation:started', r));   // поймать requestId
setTimeout(() => console.log('aborted:', URIS.abort(requestId)), 1500);
try { await p; } catch (e) { console.log(e.code); }                               // 'ABORTED'
```

Проверки: в recovery (`pending`) запись этого requestId не осталась в
`dispatchingUnknown`; сеть: POST либо не ушёл, либо оборвался — биллинг не
продолжился «вхолостую».

## E. Очередь и параллельность

```js
const runs = ['one', 'two', 'three'].map((s, i) =>
    URIS.generate({ prompt: `test pattern ${s} #${i}` }, { caller: 'console-test' }));
await URIS.getStatus().then(s => s.active);
// ожидание: 3 записи, у младших queued: true; выполняются строго по одной.
await Promise.allSettled(runs);
```

## F. Жизненный цикл: disable во время полёта

1. Запустить долгую генерацию (как в D), затем выключить URIS в панели
   расширений ST (или тумблером в настройках URIS).
2. Ожидание: и queued, и in-flight внешние запросы реджектятся `ABORTED`
   (`deactivateBridge` абортирует их контроллеры; in-flight дополнительно
   накрывает общий `abortAllGenerations` cleanup'а); `globalThis.URIS ===
   undefined`; событие `uris:bridge-destroyed`:
   ```js
   window.addEventListener('uris:bridge-destroyed', () => console.log('bridge gone'));
   ```
3. Включить обратно → `URIS` и `ready` восстановлены, `generate` работает.

## G. Сценарий «Offstage» — референс-интеграция (реализована)

Offstage — полноценный потребитель моста, не патч-кандидат. Клиент:
`lib/uris-bridge.js` (перечитывает `globalThis.URIS` на каждом вызове, poll
`ready` с дедлайном, нормализация `imagePath` и кодов), точки входа:

1. **`/offstage-draw <описание> | aspect=<ratio>`** — слеш-команда, путь
   картинки уходит в STscript-pipe (`lib/draw-commands.js`,
   `globalThis.OffstageDraw`). Быстрая проверка без GUI:
   `await OffstageDraw('test sketch', {})` → `'/user/images/…/uris_ext_offstage_….png'`.
2. **Фото-бабблы телефона** — «Дополнительно → Запросить фото» в переписке:
   описание уходит в мост (`caller: 'offstage'`, `useSceneRefs` из настроек),
   карточка рисует результат; повторная генерация с готовым `imagePath`
   невозможна — перезагрузка страницы не оплачивается дважды
   (`lib/photo-runtime.js`: один полёт на расширение, `BUSY` при параллели).
3. **`<photo>`-протокол LLM** — включается в настройках Offstage
   («Включить команды фото», режимы «по запросу»/«всегда»). Модель отвечает
   тегом, телефон парсит его в фото-заготовку и **вырезает тег из видимого
   текста** (`lib/commands-parser.js`, `lib/photo-commands.js`). Платную
   генерацию при этом запускает **клик юзера** («Сгенерировать фото» на
   карточке): автопилота нет — заготовка ложится в статус «ожидает запроса»,
   `URIS.getStatus().active` остаётся пустым до нажатия. Это сознательная
   развилка («платное — только по действию юзера», гайд §10): модель
   *предлагает* фото, оплачивает его человек.

Что проверить на живом стенде (проверено 2026-09-20, Offstage 0.8.1):

- `/offstage-draw` возвращает путь с префиксом `uris_ext_offstage_`; в
  галерее URIS карточка с тем же `requestId`.
- Ручной photo-request: в `URIS.getStatus().active` появляется запись
  `caller: 'offstage'`; по завершении картинка на баббле.
- `<photo>`-тег в ответе модели (инъекция, см. ниже): тег вырезан, баббл
  «ожидает запроса», мост пуст; клик по карточке запускает генерацию.
- Перезагрузка страницы: баббл с сохранённым `imagePath` показывает
  картинку, `generation:started` НЕ срабатывает (подписка в консоли).
- Stop таверны (`GENERATION_STOPPED`) прерывает и мостовые вызовы — фото-
  или консольный запрос в полёте получает `ABORTED`, заготовка убирается.
- Выключение URIS посреди фото-генерации → баббл не остаётся вечным
  спиннером: `ABORTED` обрабатывается молча, состояние pending можно
  перезапустить вручную.

**Детерминированная проверка тега без LLM** (модель капризна: может не
прислать тег — так проверка легко даёт ложный «зелёный»). В консоли
страницы подменяется единственная точка, через которую телефон зовёт
текстовую LLM, ответ читается как `result.content`:

```js
const svc = SillyTavern.getContext().ConnectionManagerRequestService;
const orig = svc.sendRequest;
svc.sendRequest = async function (profileId, prompt, maxTokens, opts) {
    if (window.__canned) {
        const c = window.__canned; window.__canned = null;
        return { content: c };
    }
    return orig.call(this, profileId, prompt, maxTokens, opts);
};
window.__canned = 'Вот. <photo>close-up portrait of Gaius on the basilica steps, golden hour</photo> Ну как?';
```

Затем «Продолжить переписку» в переписке. Проверить: тег вырезан из бабблов,
карточка «ожидает запроса», `URIS.listActive()` пуст; клик по карточке —
генерация с `caller: 'offstage'`. Негативы тем же способом: описание короче
3 символов — тег вырезан, баббла нет; незакрытый `<photo>` — вырезан вместе
с хвостом ответа. После проверки вернуть `svc.sendRequest = orig`.

Для аватарного сценария руками (без Offstage) — генерация квадратного
портрета и показ через `<img>`:

```js
async function testContactAvatar(name) {
    const res = await URIS.generate(
        { prompt: `square profile avatar, close-up head-and-shoulders portrait of ${name}, `
            + 'one person, clean readable face, simple unobtrusive background, no text, no logo',
          aspectRatio: '1:1', quality: 'high' },
        { caller: 'offstage' });
    console.log('avatar ready:', res.imagePath);
    return res.imagePath;   // дальше: contact.avatarUrl = res.imagePath
}
await testContactAvatar('Mira');
```

## H. Читающая поверхность (URIS ≥ 0.9.6)

```js
// Возможности соединения до платного вызова:
await URIS.getCapabilities();           // соединение текущего чата
// → {connectionId, label, modelId, ready, contract, imageGeneration,
//    references, maxReferences, sizes, qualities}

// Реестр триггер-профилей (валидные generate({trigger})):
await URIS.listTriggers();              // [{id, name, aliases, aspect, refsPolicy}] — prefix/suffix не отдаются

// Галерея: свои карточки по caller-атрибуции:
const page = await URIS.listGallery({ caller: 'console-test', limit: 5 });
page.total; page.cards;                 // [{id, imagePath, thumbPath, prompt, status, caller, requestId, …}]
await URIS.getCard(page.cards[0].id);   // одна карточка по id

// Удаление скоупнуто: своя карточка удаляется, чужая/ручная — нет:
await URIS.removeCard(page.cards[0].id, { caller: 'console-test' });   // true
await URIS.removeCard(page.cards[0].id, { caller: 'console-test' }).catch(e => e.code);
// → 'NOT_FOUND' (уже удалена)
const foreign = (await URIS.listGallery({ limit: 50 })).cards.find(c => c.caller !== 'console-test');
if (foreign) await URIS.removeCard(foreign.id, { caller: 'console-test' }).catch(e => e.code);
// → 'CARD_NOT_OWNED'; карточка на месте (проверить в галерее URIS).

// Recovery: платные запросы без подтверждённого исхода:
await URIS.listPending({ caller: 'console-test' });
// → [{requestId, caller, status, createdAt, error, prompt, referenceCount, …}]

// Классификация ошибок (та же, что в payload событий и на самих ошибках):
URIS.classifyError(Object.assign(new Error('slow down'), { code: 'UPSTREAM_HTTP_ERROR', httpStatus: 429 }));
// → {code: 'UPSTREAM_HTTP_ERROR', category: 'rate-limit', retryable: true}

// gallery-события (реактивные ленты потребителя):
URIS.on('gallery:added', d => console.log('card added by', d.card.caller, d.card.id));
URIS.on('gallery:removed', d => console.log('card removed', d.cardId));
// генерация из B → в консоли 'card added by console-test …'
```

Проверки: `page.cards` содержит только `caller === 'console-test'`; карточка
из B отбражена с тем же `requestId`; удалённая карточка пропала из
`listGallery`, но её файл остаётся в галерее таверны (`open(imagePath)`).

## Что сознательно НЕ тестируется в этой сборке

- Разрешения/allowlist по caller'ам (M3) — любое включённое расширение может
  генерировать; атрибуция логируется, а запись ограничена caller-скоупом
  `removeCard`.
- Слэш-команды `/uris:*` со стороны URIS (потребители регистрируют свои —
  как `/offstage-draw` у Offstage).
- Параллельные внешние запросы (`queue: false` доступен, но не рекомендуется).
