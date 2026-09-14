# dev ↔ deploy workflow

Два дерева одного расширения и **одна общая git-история**. Оба — клоны
`https://github.com/ochen-beep/SillyTavern-UR-Image-Studio.git`, ветка
`feat/inline-engine`.

| | dev | deploy (стенд) |
|---|---|---|
| путь | `D:\VC CODE\UR Image Studio` | `D:\SillyTavern QA\data\default-user\extensions\UR Image Studio` |
| роль | источник правды | то, что грузит SillyTavern |
| содержимое | ядро расширения | ядро + серверный WIP (ниже) |
| тесты | `npm test` | `npm test` + `npm run test:server` |
| стенд | — | http://127.0.0.1:8001/ |

Инвариант: **deploy = dev + серверный остров**. Проверка:

```bash
cd "D:/SillyTavern QA/data/default-user/extensions/UR Image Studio"
git diff --stat devrepo/feat/inline-engine HEAD
# ожидаемо: только src/image-recovery.js, src/server-*.js, src/store-*.js,
# src/reference-check.js и их тесты. Любой другой файл в выводе — расхождение.
```

## Что есть только в deploy

Серверная линия — изолированный, **ещё не подключённый** к расширению остров:

```
src/image-recovery.js           восстановление серверных запросов
src/server-image-api.js         клиент server-plugin API изображений
src/server-store-api.js         клиент server-plugin store API
src/server-connection-state.js  проба статуса серверного коннекта
src/store-state.js              проба /store/status
src/store-migration.js          миграция коллекций в серверный store
src/reference-check.js          проверка референсов
tests/server-*.test.js          тесты острова, tests/server-plugin/ — фикстуры
```

Ни `index.js`, ни один общий модуль остров не импортирует: его потребители —
только он сам и его тесты. Поэтому слияния его не ломают.

**Известное красное**: часть `tests/server-*.test.js` импортирует
`../server-plugin/src/...`, а каталога `server-plugin/` нет ни в одном дереве
(в истории dev его тоже нет). Эти тесты выведены в отдельный вход:

```bash
npm run test:server          # ожидаемо красный, пока плагина нет
```

Не зависят от плагина: `server-store-api.test.js` (зелёный) и
`server-stage2-recovery.test.js` (2 pre-existing падения `2 !== 1`, похоже на
протечку состояния между тестами).

## Синхронизация

Остров живёт только в стенде, ядро правится в dev. `devrepo` — локальный
remote, указывающий на рабочий каталог dev (настраивается один раз):

```bash
cd "D:/SillyTavern QA/data/default-user/extensions/UR Image Studio"
git remote add devrepo "D:/VC CODE/UR Image Studio"   # один раз
git fetch devrepo feat/inline-engine
git merge devrepo/feat/inline-engine                   # обычно чисто
```

Обратно (забрать остров в dev) — тем же merge из стенда.

Правила:

1. Правь ядро в dev. В стенде — только серверный остров, иначе merge начнёт
   конфликтовать на каждом шаге.
2. **Не копировать каталоги целиком** (`cp -r src deploy/src` затрёт остров).
   Если очень нужно копировать файл — сначала `diff` и убедиться, что в целевой
   версии нет уникальных строк.
3. `*.sync-conflict-*` в `.gitignore`. При появлении — сначала `diff` с текущим
   файлом и проверка blob'а в истории, только потом удаление.
4. Тесты гонять в обоих деревьях одинаковым скриптом.
5. `git fetch devrepo` после каждого коммита в dev, иначе `git diff` против
   устаревшего remote соврёт про расхождения.

## История вопроса

До 2026-09-14 деревья разъезжались: стенд отставал на 2 коммита плюс весь
незакоммиченный батч наблюдаемости, а облачная синхронизация создавала
`*.sync-conflict-*` копии. Версии при этом совпадали (0.8.6), что читалось как
«код тот же» — хотя стенд работал на старом коде (журнал 180 записей вместо
1000, отсутствие фиксов store/init/lightbox). Убрано коммитом `beecb46`,
истории объединены merge-коммитом `c4e270c`.

## Проверка на стенде

1. `http://127.0.0.1:8001/` — расширение грузится из deploy-дерева.
2. Хард-reload страницы после правок (ES-модули кэшируются браузером).
3. Консоль: логи `[URIS]`; панель расширения → Настройки → Диагностика.
