# dev ↔ deploy workflow

Два дерева одного и того же расширения. Оба — клоны
`https://github.com/ochen-beep/SillyTavern-UR-Image-Studio.git`, ветка
`feat/inline-engine`, но с разными рабочими состояниями. Эта заметка фиксирует,
что где лежит и как синхронизировать, чтобы больше не получать
`*.sync-conflict-*` мусор и расхождения в пол-релиза.

| | dev | deploy |
|---|---|---|
| путь | `D:\VC CODE\UR Image Studio` | `D:\SillyTavern QA\data\default-user\extensions\UR Image Studio` |
| роль | источник правды, полный suite | то, что реально грузит SillyTavern |
| тесты | `npm test` | `npm test` + `npm run test:server` |
| стенд | — | http://127.0.0.1:8001/ |

## Что есть только в deploy

Серверная линия разработки — изолированный, **ещё не подключённый** к
расширению остров:

```
src/image-recovery.js           восстановление серверных запросов
src/server-image-api.js         клиент server-plugin API изображений
src/server-store-api.js         клиент server-plugin store API
src/server-connection-state.js  проба статуса серверного коннекта
src/store-state.js              проба /store/status
src/store-migration.js          миграция коллекций в серверный store
src/reference-check.js          проверка референсов
tests/server-*.test.js          тесты этого острова (~23 файла)
tests/server-plugin/            фикстуры (fake-router, temp-store, ...)
```

Ни `index.js`, ни один общий модуль остров не импортирует: его потребители —
только он сам и его тесты. Поэтому синхронизация общих файлов его не ломает.

Часть островных тестов (`tests/server-*.test.js`) импортирует
`../server-plugin/src/...` — **каталог `server-plugin/` отсутствует в обоих
деревьях** (в dev-истории его тоже нет). Эти тесты запускаются отдельным
скриптом и падают на `ERR_MODULE_NOT_FOUND`, пока плагин не появится:

```bash
npm run test:server          # ожидаемо красный без server-plugin/
```

`tests/server-stage2-recovery.test.js` и `tests/server-store-api.test.js` от
плагина не зависят; первый содержит 2 pre-existing падения (`2 !== 1`,
похоже на протечку состояния между тестами), второй зелёный.

## Синхронизация

Направление всегда **dev → deploy**, потому что git-история линейна и deploy
стоит на коммите-предке. Обратно переносят только файлы острова.

```bash
DEV="/d/VC CODE/UR Image Studio"
DEP="/d/SillyTavern QA/data/default-user/extensions/UR Image Studio"

# 1. что разошлось (без node_modules/.git/tmp/логов)
cd "$DEV" && find . -type f -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './tmp_stfixture/*' -not -name '*.log' -not -name '.nano-*' \
  | sed 's|^\./||' | sort > /tmp/dev_files.txt
cd "$DEP" && find . -type f -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './tmp_stfixture/*' -not -name '*.log' -not -name '.nano-*' \
  | sed 's|^\./||' | sort > /tmp/dep_files.txt
comm -12 /tmp/dev_files.txt /tmp/dep_files.txt > /tmp/common.txt

# 2. побайтовое сравнение общих файлов
while IFS= read -r f; do
  cmp -s "$DEV/$f" "$DEP/$f" || echo "DIFF  $f"
done < /tmp/common.txt

# 3. перенести подтверждённые расхождения (dev — автор)
cp "$DEV/<file>" "$DEP/<file>"
```

Правила, чтобы не потерять работу:

1. **Не копировать каталоги целиком** — `cp -r src deploy/src` затрёт остров.
2. Перед переносом файла убедиться, что в deploy-версии нет уникальных строк:
   `diff "$DEV/$f" "$DEP/$f"` — все `>`-строки должны быть старым кодом.
3. `*.sync-conflict-*` в `.gitignore`; при появлении — сначала `diff` с текущим
   файлом, только потом удалять. Все 28 копий от 2026-09-14 оказались старыми
   снимками; ни одна не содержала уникального кода.
4. Тесты гонять в обоих деревьях одинаковым скриптом.

## Проверка на стенде

1. `http://127.0.0.1:8001/` — расширение грузится из deploy-дерева.
2. Хард-реload страницы после правок (модули кэшируются).
3. Консоль: `[URIS]` логи; панель расширения → Настройки → Диагностика.
