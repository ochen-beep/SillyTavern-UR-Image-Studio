# UR Image Studio — Дизайн (MVP)

> Дата: 2026-06-27
> Источники: `alhenassillyimages` (image-API, парсинг, кэш), `DS Comments` (плавающее окно, пресеты, метадата чата, prompt-шаблоны в localforage).
> Назначение: автономный генератор изображений внутри SillyTavern. Парсит сцену сообщения чата → text-LLM строит промпт → редактируемое окно → image-API генерит картинку в галерею расширения. Чат не мутируется.

---

## 1. Решения из брейншторма

| Тема | Решение |
|---|---|
| Flow | Две стадии: text-LLM → редактор промпта → image-API |
| Источник сцены | Последнее AI-сообщение автоматически + навигатор постов (`←` `→`) вручную |
| Редактор промпта | Поля (style/prompt/aspect/size) + кнопка «показать сырой JSON» |
| Режимы генерации | auto / confirm / manual |
| Референсы | Текстовые пресеты персонажей (для text-LLM) + опц. аватары (image-to-image для image-API) |
| API-пресеты | Раздельно: список text-коннектов + список image-коннектов |
| Персонажи | 2 фиксированных слота (`{{char}}`, `{{user}}`) + динамические через `+` (имя-в-сцене + описание) |
| Привязка пресетов к чату | ID пресетов в метадате чата (`chatMetadata.uris_binding`) |
| Галерея | Персистентно в localforage, «Сохранить» копирует файл в ST через `/api/images/upload` |
| Карточка галереи | 4 кнопки (удалить/перегенерировать/сохранить/копировать промпт) + lightbox + mobile-friendly |
| Доп. MVP-функции | Очередь пакетной генерации; история последних N промптов |
| Поддерживаемые API | Только OpenAI и Gemini |

## 2. Ключевые принципы

- **Автономность (п.6 требований):** `message.mes` никогда не мутируется расширением. Картинки существуют только в галерее (localforage). Фоновая генерация чата не блокируется.
- **Двухстадийность:** между стадиями стоит редактор, через который проходит каждый промпт. Даже в auto-режиме пользователь видит заполненные поля.
- **Привязка к чату:** открыть чат → подтянулись пресеты, сохранённые для этого чата. Сменить пресет в окне → автосохранение в метадату.

## 3. Модули

```
UR Image Studio/
├─ manifest.json
├─ index.js              ← lifecycle hooks + оркестрация
├─ style.css
├─ settings.html         ← панель настроек в ST Extensions
└─ src/
   ├─ core.js            ← state, MODULE_NAME, defaults, settings persistence, utils (log, debounce, escapeHtml)
   ├─ presets.js         ← CRUD text/image/character/template пресетов в localforage
   ├─ chat-binding.js    ← чтение/запись привязки пресетов в chatMetadata
   ├─ prompt-builder.js  ← сборка системного промпта text-LLM (шаблон + персонажи + инструкция вернуть JSON)
   ├─ text-api.js        ← стадия 1: OpenAI /chat/completions + Gemini generateContent
   ├─ image-api.js       ← стадия 2: OpenAI /images/generations + Gemini (imageConfig)
   ├─ references.js      ← аватары char/user → dataUrl
   ├─ pipeline.js        ← двухстадийный flow + очередь пакетной генерации
   ├─ parser.js          ← извлечение data-iig-instruction JSON из ответа text-LLM
   ├─ events.js          ← ST events (генерация завершена → автоген) + scroll-observer навигатора постов
   ├─ storage.js         ← localforage галерея + сохранение через ST /api/images/upload
   ├─ history.js         ← дропдаун последних N промптов
   └─ ui/
      ├─ window.js       ← плавающее окно (mount, drag, resize, mobile)
      ├─ tabs.js         ← переключение вкладок
      ├─ tab-generate.js ← редактор промпта + режимы + история + очередь
      ├─ tab-gallery.js  ← карточки + mobile-сетка
      ├─ tab-presets.js  ← управление пресетами + привязка к чату
      └─ lightbox.js     ← fullscreen просмотр + mobile swipe
```

## 4. Data flow

### Авто-режим

1. **events.js** ловит `GENERATION_ENDED` (или эквивалент). Берётся последнее AI-сообщение (по scroll-observer/последнему mesid). Текст сцены = `message.mes`.
2. **pipeline.js → стадия 1 (text-api.js):** `prompt-builder.js` собирает системный промпт = выбранный шаблон (дефолт — приложенный файл, очищенный от `<manga>`, `[MNG:...]`, `[IMG:GEN]`, `src=`) + активные пресеты персонажей + инструкция «верни JSON data-iig-instruction». Вызов text-коннекта.
3. **parser.js** достаёт `{style, prompt, aspect_ratio, image_size}` из ответа.
4. **ui/tab-generate.js** заполняет поля редактора. auto → сразу «Отправить в image-API». confirm → ждёт ОК. manual → ждёт ручного запуска.
5. **pipeline.js → стадия 2 (image-api.js):** `references.js` при разрешении собирает аватары. Вызов image-коннекта (openai | gemini). Получаем dataUrl.
6. **storage.js** сохраняет запись в localforage галерею. **ui/tab-gallery.js** добавляет карточку.

### Ручной запуск

Кнопка «Сгенерировать из сообщения» в окне: тот же flow, но стадия 1 стартует по клику для выбранного через навигатор поста.

### message.mes не мутируется

Картинка живёт только в галерее. Чат остаётся чистым → автоген крутится параллельно с обычным общением.

## 5. Модель данных

### Пресет text-коннекта (`uris_text_presets`)

```js
{ id, name, apiType: 'openai'|'gemini', endpoint, apiKey, model }
```

### Пресет image-коннекта (`uris_image_presets`)

```js
{ id, name, apiType: 'openai'|'gemini', endpoint, apiKey, model,
  size?, quality?,                    // OpenAI
  aspectRatio?, imageSize?,           // Gemini
  sendCharAvatar?, sendUserAvatar?, userAvatarFile?,
  referenceMode?: 'always'|'never' }  // упрощено: tag_controls не нужен (тегов из чата нет)
```

### Пресет персонажа (`uris_characters`)

```js
{ id, role: 'char'|'user'|'custom', name, sceneName, description }
// role=char/user — два фиксированных слота; sceneName — как персонажа зовут в текущем чате
// role=custom — добавленные через «+»: пользователь сам задаёт name/sceneName/description
```

### Шаблон промпта (`uris_templates`)

`string` (дефолт = приложенный файл без экранирующих тегов). Хранится по id, несколько штук.

### Привязка к чату (`chatMetadata.uris_binding`)

```js
{ textPresetId, imagePresetId, characterIds: [...], templateId }
```

### Галерея (`uris_gallery_<chatId>`)

Массив записей:
```js
[{ id, ts, src, prompt, style, aspectRatio, imageSize, refsSig, sourceMsgId, saved: bool }]
```

### История промптов (`uris_prompt_history_<chatId>`)

Массив строк (последние N=20). Перезаписываемые пользовательские промпты.

## 6. UI / Mobile

- **Окно:** full-screen overlay при ширине < 768px (`isMobileViewport`, как DS Comments). Десктоп — перетаскиваемое, ресайзабельное.
- **Галерея:** 1 колонка < 480px, 2 колонки < 768px, 3+ на десктопе. Кнопки 44px тап-зоны.
- **Lightbox:** на весь экран; swipe влево/вправо — листание галереи; swipe вниз — закрытие.
- **Редактор промпта:** поля в одну колонку на mobile; дропдаун истории — нижняя шторка.

## 7. Обработка ошибок

- Ретраи с экспоненциальной задержкой (как `alhenassillyimages`) на 429/503/timeout — на обеих стадиях.
- Карточка ошибки с кнопкой «повторить».
- Лог-буфер + экспорт логов.

## 8. Автономность

- `message.mes` не мутируется. Картинки — только в галерее localforage.
- Фоновая генерация чата не блокируется: расширение только читает `message.mes` и шлёт свои запросы.
- `AbortController` на каждой стадии: можно отменить.

## 9. Что НЕ входит в MVP (YAGNI)

- Поддержка Naistera/Grok (только OpenAI + Gemini).
- Теги `[IMG:GEN]` в постах чата (генерация только из расширения).
- Тег-управляемые референсы (`tag_controls`) — некому их ставить.
- Режим генерации «вставить в чат» / «использовать как референс» на карточке.
- Генерация вариаций (3 альтернативы через text-LLM).
