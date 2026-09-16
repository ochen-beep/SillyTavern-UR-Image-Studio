# Chat Completions: каналы пропорции и размера (gemini-image на OpenAI-совместимых шлюзах)

Дата: 2026-09-16. Контекст: мост Offstage → URIS → шлюз ddtnew (new-api). Жалоба
партнёра: запрос с `aspectRatio: '9:16'` возвращал картинку 1376×768 (дефолт
модели), и никто — ни вызывающий, ни пользователь — об этом не узнал.

## Как устроено теперь

Канонический источник пропорции — структурный выбор (`request.aspectRatio`:
селект вкладки, глобальный дефолт, профиль триггера или параметр моста).
Правило одного канала: пропорция едет **параметром**, когда контракт умеет;
когда не умеет — вызывающий и пользователь получают **честное предупреждение**.
Текст промпта параметром не подменяется (см. «почему не промпт-текст»).

| Контракт | Канал пропорции | Проверено |
|---|---|---|
| `gemini-native` | `generationConfig.imageConfig.aspectRatio` | да (ddtnew, 768×1376) |
| `openrouter-images` | `aspect_ratio` / `resolution` / `quality` на `/api/v1/images` | доки OpenRouter |
| `chat-completions` + `new-api` | `extra_body.google.image_config.{aspect_ratio, image_size}` (snake_case!) | да (ddtnew + apiddt, 768×1376) |
| `chat-completions` + `openrouter` | top-level `image_config` + `modalities: ['image','text']` | доки OpenRouter |
| `openai-images` | `size` (маппинг `ASPECT_SIZES`) | да (ddtnew, 1024×1536) |
| `chat-completions` без оверрайда | **канала нет** → warning в `result.warnings` | да |

Выбор канала — оверрайд «Параметры изображений Chat Completions» в карточке
подключения (`overrides.chatCompletionsImageConfig`: `''` / `new-api` /
`openrouter`), приходит в адаптер капабилити
`route.capabilities.chatCompletionsImageConfig`.

## Почему не промпт-текст (важно для ревью)

Предложение «дописывать пропорцию в промпт» проверено живьём на ddtnew
(`gemini-3.1-flash-image-preview`, 2026-09-16) и **не сработало**: фразы
«Generate the image in a 9:16 aspect ratio (portrait orientation).» (в конце) и
«Vertical portrait composition, tall 9:16 aspect ratio image.» (в начале)
обе вернули дефолтные 1376×768. Google официально демонстрирует текстовое
задание пропорции (пример «…generate each image in a 1:1 aspect ratio» в
Cloud-доках), но поведение зависит от модели/апстрима шлюза, и полагаться на
него — значит снова получить молчаливый отказ. Поэтому текст — не канал, а
источник **конфликтов**:

- если параметрный канал активен и в эффективном промпте есть явный токен
  пропорции, противоречащий настройкам («16:9» в тексте против «9:16» в
  селекте), адаптер возвращает warning «в промпте указано X, а в настройках Y»;
  провод не переписывается;
- токен считается пропорцией, только если его сокращённая дробь входит в
  `VALID_ASPECT_RATIOS` или он численно совпадает с запрошенным (±2%) —
  «10:30» на циферблате тревогу не поднимает;
- без параметрного канала конфликт-детектор молчит: там и так warning о
  непередаче.

Арифметика — в `src/aspect-ratio.js` (`promptAspectConflicts`,
`aspectDeviates`, `reducedRatio`). Сравнение числовое с допуском 4%:
документированный слот Gemini 9:16 — это 768×1344, что gcd-сокращается до
4:7, и строковое сравнение дробей давало бы ложную тревогу.

## Постфактум-сверка

После материализации `src/image-api.js` сравнивает фактические пиксели с
`snapshot.aspectRatio`; отклонение > 4% добавляет warning в `result.warnings`
и пишет событие `aspect-mismatch` в диагностический журнал. Это единственная
проверка, которая ловит «параметр отправили, шлюз проигнорировал».

Куда доезжают warnings: тост вкладки «Генерация» (`tab-generate.js`),
карточка пайплайна (`pipeline-stage2.js`), результат моста
(`bridge.js` → `payload.warnings` — Offstage читает), журнал
`provider-warnings`.

## Бонус: connection.extraBody теперь применяется

Поле «Доп. параметры body (JSON)» карточки существовало и сохранялось, но
chat-completions его игнорировал (читал только naistera). Теперь адаптер
глубоко сливает `connection.extraBody` в тело запроса (extra выигрывает),
не позволяя перетирать служебные `model` / `messages` / `stream`. Это же
эвакуационный люк для прочих причуд шлюзов.

## Эксперименты (ddtnew.com / apiddt.com — new-api, 2026-09-16)

| # | Запрос к /v1/chat/completions | Результат |
|---|---|---|
| T1 | обычный промпт | 1376×768 (дефолт модели) |
| T2/T2b | пропорция текстом в промпте (конец/начало) | 1376×768 — **проигнорировано** |
| T3 | top-level `image_config` + `modalities` (OpenRouter-стиль) | 1376×768 — молча проигнорировано |
| T4 | `extra_body.google.image_config.aspect_ratio: "9:16"` | **768×1376** |
| T5 | то же, но camelCase `aspectRatio` | HTTP 500 `convert_request_failed` до оплаты |
| T7 | `gemini-native` `generationConfig.imageConfig.aspectRatio` | **768×1376** |
| T8 | `openai-images` `size: "1024x1536"` (gpt-image-2.5) | **1024×1536** |

Fingerprint: ddtnew.com и apiddt.com — QuantumNous/new-api (заголовок
`X-Oneapi-Request-Id`, схема `/api/status`, конвертер
`relaykit/relayconvert/internal/oai_chat/to_gemini_chat_req.go` в исходниках
new-api подтверждает форму `extra_body.google.image_config` и молчаливое
игнорирование top-level `image_config`).

## Что осталось за кадром (возможные следующие шаги)

- Автодетект new-api по `/api/status` (без CORS из браузера ненадёжен) — пока
  оверрайд ставится вручную.
- `quality` на chat-completions не передаётся ни в одном диалекте — warning
  при непустом значении; если появится документированный член — добавить.
- Generic `extraBody` пока слит только в chat-completions; остальные адаптеры
  (gemini-native, openai-images) поле по-прежнему игнорируют.
