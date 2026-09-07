# docs

Документация UR Image Studio. Код (`src/`) — источник правды; здесь —
исторические записи и операционка.

## Структура

- `CHANGELOG.md` — журнал изменений. Новые записи сверху (обратный хронологический
  порядок). Версия релиза живёт в `manifest.json` (`version`) и является
  авторитетной; метки `v2.x` внизу CHANGELOG — внутренние имена ранних этапов.
- `cors-proxy-setup.md` — настройка CORS-прокси SillyTavern для запросов к
  провайдерам из браузера.
- `runbooks/` — операционные руководства по разбору конкретных инцидентов.
- `archive/` — исторические планы (`archive/plans/`) и спеки (`archive/specs/`)
  реализованных или превзойдённых фич. Актуальные имена модулей сверяй с `src/` —
  ранние записи могут ссылаться на модули, переименованные при рефакторинге
  пайплайна (напр. `stage1-adapter.js`/`parser.js` → `pipeline-stage1.js` и т.п.).
- `abandoned/` — планы и спеки фич, которые так и не были реализованы
  (Pollinations/Agnes и HuggingFace как отдельные провайдеры). Оставлены для
  возможного возрождения.
- `providers/` — актуальные технические contract notes. См. `pollinations-contract.md`
  и design-only note для Naistera.

## Вендоренный код

- `src/vendor/fzstd.esm.js` — [fzstd](https://github.com/101ARROWZ/FZSTD) v0.1.1
  (автор 101arrowz, лицензия MIT): копия официального ESM-бандла с jsDelivr
  (`https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm`), байт-в-байт совпадает с ним —
  сверху добавлен только комментарий-шапка `VENDORED — do not hand-edit`.
  В `package.json` fzstd не указан (не npm-зависимость); обновление — ручной
  заменой файла на свежий бандл с сохранением шапки.
- Зачем: zstd-декодер (RFC 8878) для ответов через ST `/proxy/`, который
  пересылает сжатые байты, скрывая upstream Content-Encoding (runbook
  `runbooks/2026-07-11-gemini-zstd-proxy-response.md`, спека
  `archive/specs/2026-07-12-zstd-response-decompression-design.md`). Работает
  как fallback, когда в браузере нет нативного `DecompressionStream('zstd')`.
- Где используется: единственный импорт — `src/core.js` (`decodeZstdBytes`);
  через него декодер берут `src/catalog.js` и `src/providers/image-base.js`
  (`readJsonResponse`), `src/proxy.js` упоминает его только в комментарии.
  Тесты с реальными zstd-байтами: `tests/catalog.test.js`,
  `tests/core-response.test.js`, `tests/image-base-read-json-response.test.js`.

## Ограничения и политика

- Поддерживаемый сценарий: одна SillyTavern-инсталляция на одной машине и один рабочий аккаунт/профиль браузера.
- Сетевой дамп URIS записывается всегда для запросов расширения и хранит последние 200 записей; он экспортируется отдельной кнопкой и не переносится обычным backup.
- Внешние URL референсов разрешены и могут потребовать CORS-прокси SillyTavern.
- Backup не переносит gallery metadata, native image files или API-ключи. Chat binding экспортируется только для текущего чата и без remapping идентификаторов.
- `clean` не является пользовательской очисткой данных; lifecycle cleanup выполняется при disable.

Полный suite запускается из корня расширения:

```bash
node --test
```

Focused проверка Pollinations/cap/reference boundary:

```bash
node --test tests/pollinations.test.js tests/catalog.test.js tests/connect-probe.test.js tests/netdump.test.js tests/references.test.js tests/scene-context.test.js tests/capability-observer.test.js
```
