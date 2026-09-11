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
3. Смысл: потребителю (Offstage и т.п.) не нужно повторять пайплайн URIS —
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

## G. Сценарий «Offstage» — аватар контакта руками

Минимальная проверка consumer-сценария телефона: сгенерировать квадратный
портрет и отдать путь в `<img>` (в Offstage аватар рисует
`createContactAvatar` → `attachImage(container, contact.avatarUrl, …)` —
путь из моста подойдёт без изменений, `safeAvatarUrl` пропускает
same-origin `/…`).

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

После обкатки сценария G в коде Offstage появляется один адаптер
(`lib/image-bridge.js`, ~15 строк: guard `globalThis.URIS` + `await ready` +
`generate` с `caller: 'offstage'`) и точка вызова — см. «Минимальный патч
Offstage» ниже.

## Минимальный патч Offstage (после успешного G)

```js
// lib/image-bridge.js — в стиле репозитория: зависимости инъектятся, node-тестируемо
export function createImageBridge({ getUris = () => globalThis.URIS } = {}) {
    return {
        available: () => !!getUris(),
        async generateAvatar({ name, appearancePrompt = '', signal } = {}) {
            const uris = getUris();
            if (!uris) throw Object.assign(new Error('URIS not installed'), { code: 'uris_unavailable' });
            await uris.ready;
            return uris.generate(
                { prompt: `square profile avatar, head-and-shoulders portrait of ${name}. ${appearancePrompt}`,
                  aspectRatio: '1:1' },
                { caller: 'offstage', signal });
        },
    };
}
```

Точка входа в текущем состоянии — там, где контакт получает `avatarUrl`
(`lib/context.js` `normalizeCharacter` сейчас ставит только ST-thumbnail).
Патч-кандидат: опция «сгенерировать аватар через URIS» в контекстном меню
контакта (их message-menu.js), результат пишется в персистентный contact как
`avatarUrl` (создаётся поле `avatarSource: 'uris'`, чтобы rebuild не
перезатирал путь ST-thumbnail'ом). Это предложение, не реализация.

## Что сознательно НЕ тестируется в этой сборке

- Разрешения/allowlist по caller'ам (M3) — любой включённый扩展 может
  генерировать; атрибуция только логируется.
- `refId` из пула референсов, слэш-команды `/uris:*`, `buildPrompt`/
  `generateForMessage` (M2).
- Параллельные внешние запросы (`queue: false` доступен, но не рекомендуется).
