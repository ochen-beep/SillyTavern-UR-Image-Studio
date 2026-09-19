# Брифинг для ИИ-агента: интеграция с UR Image Studio (URIS) через мост

> Цель документа: у вас (агент) есть код стороннего SillyTavern-расширения
> (телефон, визуальная новелла, генератор аватаров и т.п.). Заказчик хочет,
> чтобы ваше расширение запускало **генерацию изображений через URIS** — по
> ключевым словам в сообщениях, маркерам в ответах LLM, кнопкам или слеш-командам.
> Этот документ содержит всё необходимое: что такое URIS, контракт моста,
> готовые рецепты триггеров и правила, нарушение которых ломает интеграцию.
> Документ самодостаточен: доступ к репозиторию URIS не требуется.

---

## 1. Что такое URIS (контекст, 30 секунд)

**UR Image Studio (URIS)** — расширение SillyTavern, «студия генерации
изображений»: много провайдеров (OpenAI-совместимые, Gemini, OpenRouter,
Pollinations, Naistera…), соединения с ключами, пул референсов персонажей,
промпт-шаблоны, галерея, диагностика, отмена. Всё настроено пользователем
внутри URIS — **ваш код не настраивает ни ключи, ни endpoint'ы**.

Ваша задача — только **триггер и показ**: поймать момент «нужна картинка»,
попросить URIS сгенерировать, встроить результат.

## 2. Мост: контракт в одном абзаце

URIS публикует глобальный объект страницы `globalThis.URIS` (контракт
`apiVersion: 1`). Это request/response API: вы вызываете метод → получаете
промис с результатом или ошибкой со структурным кодом. События есть, но
необязательны. Мост включается тумблером «Разрешить генерацию другим
расширениям» в настройках URIS (по умолчанию включён).

```js
// Минимальный клиент — вставьте в свой модуль как есть:
export const urisReady = async (timeoutMs = 15000) => {
    const t0 = Date.now();
    while (!globalThis.URIS) {
        if (Date.now() - t0 > timeoutMs) throw Object.assign(
            new Error('URIS not installed or disabled'), { code: 'URIS_UNAVAILABLE' });
        await new Promise(r => setTimeout(r, 150));
    }
    // ready реджектится (НЕ висит), если init URIS упал или URIS выключили
    // до готовности — оберните в try/catch и деградируйте тихо.
    await globalThis.URIS.ready;
    return globalThis.URIS;   // ВАЖНО: ссылку не кэшировать, звать globalThis.URIS каждый раз
};

export async function urisGenerate(request, opts) {
    const URIS = await urisReady();               // opts.caller обязателен!
    return URIS.generate(request, { caller: 'my-extension', ...opts });
}
```

## 3. API v1 (полная поверхность)

| Метод | Вход → Результат |
|---|---|
| `generate(req, opts)` | `{prompt, aspectRatio?, imageSize?, quality?, references?, connectionId?, modelId?, useSceneRefs?, expandMacros?}` + `{caller, signal?, onStatus?, queue?}` → `{requestId, cardId, imagePath, width, height, warnings}` |
| `buildPrompt(req, opts)` | `{text, templateId?, useScene?=true, expandMacros?=true}` → `{requestId, prompt, templateId, templateType, matchedReferences, ambiguities}` — Stage 1 URIS над произвольным текстом |
| `getStatus()` | `{enabled, ready, accepting, connection, active}` |
| `listConnections()` | `[{id, label, modelId, ready}]` — без ключей |
| `listRefs()` / `listTemplates()` | sanitized-списки |
| `abort(requestId)` | `bool` — отмена, в т.ч. стоящего в очереди |
| `on(type, cb)` / `off` | события `generation:queued/started/ended/error`, `prompt:*`, `'*'` |

- Константы: `aspectRatio` ∈ `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`;
  `imageSize` ∈ `1K, 2K, 4K`; `quality` ∈ `auto, high, medium, low`.
- `references`: `[{refId}]` (из пула URIS) и/или `[{dataUrl, name}]` (свои байты);
  `useSceneRefs: true` — автореференсы по упоминаниям в промпте.
- Макросы `{{char}}`/`{{user}}` в prompt/text разворачиваются (не хотите — `expandMacros: false`).
- **`caller`** — обязательный тег вашего расширения (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`),
  по нему пользователь видит, кто тратил деньги. Задайте константой.

### Коды ошибок (`err.code`) — ветвление делайте по коду, не по тексту

| Код | Действие |
|---|---|
| `URIS_UNAVAILABLE` | не установлен → спрятать кнопки, не падать |
| `EXT_DISABLED` / `NOT_READY` | выключен/грузится → подсказка |
| `NO_CONNECTION`, `ROUTE_SELECTION_REQUIRED`, `MISSING_API_KEY`, `*_TOKEN_REQUIRED` | юзеру настроить URIS (показать `err.message`) |
| `REF_NOT_FOUND`, `REF_UNAVAILABLE`, `TEMPLATE_INVALID`, `NOT_FOUND` | конфигурация |
| `INVALID_PARAMS`, `INVALID_CALLER` | ваш баг |
| `ABORTED` | **отмена — не ошибка**, убрать заготовку молча |

## 4. Результат и показ

`result.imagePath` — постоянный файл SillyTavern
(`user/images/<папка>/uris_ext_<caller>_….png`):

```js
const img = document.createElement('img');
img.src = '/' + result.imagePath;      // просто путь, не dataURL
```

Храните `imagePath` в своих сообщениях/записях (переживает перезагрузку),
клик — ваш лайтбокс или что угодно. Карточка в галерее URIS создаётся
автоматически. Для vision-модели: `fetch('/'+path)` → blob → dataURL.

## 5. Рецепты триггеров — что реализуете вы

Мост — пассивный сервис: **всю логику «когда генерировать» пишет потребитель**.
Готовые паттерны (комбинируются):

### 5.1. Ключевые слова в сообщении пользователя

Слушайте событие ST, ловите интент, генерируйте:

```js
const ctx = SillyTavern.getContext();
ctx.eventSource.on(ctx.event_types.MESSAGE_SENT, async (msgId) => {
    const text = String(ctx.chat?.[msgId]?.mes || '');
    if (!/(селфи|фото|снимок|покажи|picture|photo|selfie)/i.test(text)) return;
    // ...показать pending, затем:
    const res = await urisGenerate({ prompt: buildPromptFrom(text), aspectRatio: '9:16' },
                                   { signal: ctl.signal });
    // ...показать res.imagePath
});
```

Если картинка должна «прийти от персонажа» — генерируйте по
`GENERATION_ENDED` (ответ уже дописан) и вставляйте в свой UI как входящее
медиа. Если вы — телефон с композером (Offstage-стиль), перехват делайте в
своём обработчике отправки, до запроса LLM.

### 5.2. Маркеры LLM в ответе (персонаж «сам» шлёт фото)

1. **Обучение**: добавьте в свой промпт-конвейер блок (постоянно или только
   когда юзер просил фото — «условное обучение»):
   > Ты можешь отправлять фотографии. Чтобы отправить фото, включи в ответ
   > строку `<photo>визуально конкретное описание сцены на английском</photo>`.
2. **Парсинг** ответа перед показом: вырезать маркер, на его место —
   pending-заготовка; описание — в мост:
   ```js
   const m = /<photo>([\s\S]+?)<\/photo>/i.exec(replyText);
   if (m && m[1].trim().length >= 3) {
       const shell = mountPendingShell();
       urisGenerate({ prompt: m[1].trim(), useSceneRefs: true }, { signal })
           .then(r => shell.show('/' + r.imagePath))
           .catch(e => e.code === 'ABORTED' ? shell.remove() : shell.error(e.message));
   }
   ```
3. Маркер остаётся в сохранённом тексте (модель видит свои прошлые теги —
   формат самоподдерживается), юзеру не показывается. Слабое/пустое описание —
   деградация (скрыть), не вызов моста.
   **Развилка платного клика**: пример выше — автопилот (генерация сразу по
   тегу; легально только при явном согласии юзера, §6.5). Консервативный
   вариант референс-интеграции (Offstage): тег превращается в заготовку
   «фото ожидает запроса», платный вызов — по клику юзера по карточке.

### 5.3. Кнопка в вашем UI

Обработчик клика → §3 `generate` → показать. Требования к кнопке: пока запрос
идёт — состояние «занято» + возможность отмены; при отсутствии URIS — скрыта
или ведёт себя как подсказка.

### 5.4. Слеш-команда

URIS своих `/uris:*` команд пока не регистрирует — зарегистрируйте свою,
дёргающую мост (тогда она доступна из Quick Replies, STscript, `/run`):

```js
const ctx = SillyTavern.getContext();
ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'myext_draw',
    callback: async (namedArgs, unnamedArgs) => {
        const prompt = String(Array.isArray(unnamedArgs) ? unnamedArgs.join(' ') : unnamedArgs || '').trim();
        const res = await urisGenerate({ prompt }, {});
        return String(res.imagePath);   // путь уходит в pipe
    },
    unnamedArgumentList: [ctx.SlashCommandArgument.fromProps({
        description: 'Visually concrete description',
        typeList: [ctx.ARGUMENT_TYPE.STRING],
        isRequired: true,
    })],
    help: 'Сгенерировать картинку через URIS и вернуть путь',
    returns: 'image path',
}));
```
(Рабочий пример целиком — `SlashCommand.fromProps` + `SlashCommandArgument.fromProps` —
смотрите в Offstage `lib/draw-commands.js`; в старых версиях ST —
`registerSlashCommand`.)

### 5.5. Что НЕ делать

- Не сканируйте чужие хранилища/папки и не импортируйте чужие модули —
  только глобал `globalThis.URIS`.
- Не стройте свою очередь параллельных генераций — мост серийный (один
  платный POST за раз), этого достаточно.
- Не кэшируйте объект моста между вызовами (URIS могут выключить/включить).
- Не пишите в `extensionSettings.ur_image_studio` и не читайте чужие ключи.

## 6. Обязательный UX-минимум

1. **Pending-состояние**: генерация идёт 5–60 сек — заготовка (скелетон/
   спиннер + текст статуса из `onStatus`) живёт всё это время, с кнопкой
   отмены (`AbortController` → `signal`).
2. **Отмена реальна**: `ctl.abort()` останавливает и стоящий в очереди, и
   летящий запрос. Если POST уже ушёл — провайдер мог списать токены; URIS
   оставит recovery-запись, не молчите об ошибке юзеру — покажите по `err.code`.
3. **Stop таверны** (красная кнопка ST) останавливает и мостовые запросы —
   ваш UI должен корректно убрать заготовку (ловите reject `ABORTED`).
4. **Деградация без URIS**: `globalThis.URIS === undefined` → скрыть
   функцию, не блокировать загрузку расширения. Свой `init` не вешать на
   `ready()` без таймаута.
5. **Платное только по действию**: автогенерация (без клика юзера) — только
   если юзер явно включил её в ВАШИХ настройках; лимиты — на вашей стороне.

## 7. Чек-лист приёмки

- [ ] `caller` — константа расширения, валидный тег
- [ ] Все вызовы через `globalThis.URIS` в момент вызова, с `signal`
- [ ] Pending-UI с отменой; `ABORTED` обрабатывается молча
- [ ] `err.code`-свитч на все коды из §3; тексты сообщений не парсятся
- [ ] `imagePath` сохраняется в вашем хранилище; показ через `<img src="/+path">`
- [ ] Без URIS расширение работает (кнопки скрыты/подсказка), не падает
- [ ] Выключение URIS посреди генерации → заготовка убрана, не «вечный спиннер»
- [ ] Триггер(ы) из §5 реализованы и не стреляют повторно на перезагрузку
      (перезагрузка страницы не должна запускать новую платную генерацию для
      уже сгенерированного контента — проверяйте сохранённый `imagePath`)

## 8. Как проверить без живого юзера

1. Консоль DevTools таверны:
   `typeof URIS` → `'object'`; `await URIS.getStatus()`; тестовая генерация
   с `caller: 'selftest'` (это платный вызов — одной штуки достаточно).
2. Вкладка **URIS «Мост»** (Настройки URIS → «Показывать вкладку „Мост"»):
   ручные вызовы без консоли, в т.ч. с телефона.
3. Негативные тесты: выключить тумблер моста → `EXT_DISABLED`; выключить URIS
   → `globalThis.URIS === undefined` + событие `uris:bridge-destroyed`;
   неверный `refId` → `REF_NOT_FOUND`.

---

*Полные материалы (drop-in клиент, полный гайд, runbook): репозиторий URIS,
`docs/bridge-dev-guide.md`, `docs/devkit/uris-client.js`,
`docs/bridge-test-runbook.md`. Контракт: apiVersion 1, изменения аддитивны.*
