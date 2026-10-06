# Как расширения SillyTavern дают пользователю настраивать ComfyUI

> Исследование от 2026-10-01 (агент). Методика: исходники из репозиториев (raw) и issues через GitHub API. Исключение: TTWParty/SillyTavern-RBQ-Draw — бандл минифицирован, механика восстановлена по извлечённым UI-строкам + README. Спутниковый отчёт к [синтезу улучшений](2026-10-01-comfy-provider-improvements.md).

## (a) Разбор по проектам

### 1. Ядро SillyTavern — расширение Image Generation

Файлы: [public/scripts/extensions/stable-diffusion/index.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/stable-diffusion/index.js), [comfyWorkflowEditor.html](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/stable-diffusion/comfyWorkflowEditor.html), [src/endpoints/stable-diffusion.js](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/stable-diffusion.js), пресеты [Default_Comfy_Workflow.json](https://github.com/SillyTavern/SillyTavern/blob/release/default/content/Default_Comfy_Workflow.json), [Stable-Diffusion.md](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/extensions/Stable-Diffusion.md).

**Флоу настройки:** Source=ComfyUI → URL + «Connect» (ping `/system_stats`) → дропдаун workflow (json-файлы в `data/<user>/workflows/`) → «Open workflow editor» (попап) → вставить JSON от «Save (API Format)» → **вручную заменить значения на `%плейсхолдеры%`** → Save. Кнопки New/Rename/Delete; слэш-команда `/imagine-comfy-workflow <имя>` переключает workflow на лету.

**Списки из сервера:** один запрос `/object_info`, из него — `KSampler.sampler_name/scheduler`, `VAELoader.vae_name`, модели из **трёх загрузчиков сразу**: `CheckpointLoaderSimple.ckpt_name` + `UNETLoader.unet_name` (префикс «UNet: ») + `UnetLoaderGGUF` (префикс «GGUF: »). Имена «причёсываются»: расширение срезается, `_` → пробел.

**Подстановка:** только точные строки **в кавычках** — `"%prompt%"`, `"%seed%"` и т.д. через `replaceAll` на `JSON.stringify(значение)`. Базовые плейсхолдеры: prompt, negative_prompt, model, vae, sampler, scheduler, steps, scale, denoise, clip_skip, width, height, user_avatar, char_avatar, seed (у seed — «ST сам генерирует случайный сид»).

**Кастомные плейсхолдеры (comfy_placeholders):** пары find/replace прямо в редакторе; replace проходит через `substituteParams` → работают `{{char}}`, `{{getvar::...}}` ([issue #1567](https://github.com/SillyTavern/SillyTavern/issues/1567)).

**Фишка редактора:** список всех плейсхолдеров сбоку, каждый **живьём помечен найден/не найден** в тексте workflow (класс `sd_comfy_workflow_editor_not_found`; в доках — ✅/❌). Пользователь сразу видит, что забыл `%model%`.

**Ошибки:** валидации до отправки нет; сервер парсит `history[id].status.messages` → формат `node_type [node_id] exception_type: exception_message`, клиент показывает toastr.error.

**Дефолтный workflow:** минимальный txt2img с плейсхолдерами внутри; второй пресет — img2img с аватаром персонажа. (Исторический дефолт выходил сломанным — [#2322](https://github.com/SillyTavern/SillyTavern/issues/2322): дефолты надо тестировать.)

### 2. mozophe/ST-ComfyUI-Imagine

Репо: https://github.com/mozophe/ST-ComfyUI-Imagine.

**Флоу:** флаги ComfyUI → (опц.) кастомная нода Image Saver → URL + Test + inline-подсказки про `--listen`/CORS → Upload Workflow (API-формат) → выбор активного workflow → опц. привязка LoRA к персонажу.

**Ключевая механика — конвенции вместо маппинга:** ноды ищутся **по `_meta.title`**: `IMAGINE_PROMPT`, `IMAGINE_NEGATIVE`, `IMAGINE_LORA`, `IMAGINE_LORA_TRIGGER`. Фолбэк: первый `CLIPTextEncode` = позитив, второй = негатив. «The extension finds nodes by title, so it does not care what your graph looks like». Запись — `setNodeText`: `inputs.text` → `inputs.value` (PrimitiveString) → `widgets_values[0]`; если поле — линк, ошибка **с именем ноды**: `Node "X" has no literal text/value field (wired as link). Cannot inject.`

**Детект не того формата:** массив `nodes` в JSON → «Workflow looks like a UI export, not API format…» + раздел Troubleshooting.

**Из сервера:** `/object_info/LoraLoader` → дропдаун LoRA с Reload. Фишка: LoRA привязана к персонажу (strength + trigger words); когда LoRA не задана, нода `IMAGINE_LORA` **нейтрализуется** (strength=0), а не оставляется «как экспортировалась» — защита от запечённых значений.

**Прочее:** seed рандомизируется во всех KSampler/KSamplerAdvanced; два шаблона workflow в репо с предупреждением «начинайте со своего рабочего графа и добавьте титулы»; настройки в 4 табах с inline-подсказками.

### 3. lumingya/ST-Comfyui-Simplified

Репо: https://github.com/lumingya/ST-Comfyui-Simplified. Слоган: «экспорт → импорт → вписать ID нод».

**Флоу:** Dev Mode → Save (API Format) → импорт .json → вписать **ID входной ноды** (по умолчанию 6) и опц. **ID выходной** (пусто = авто) → сохранить → тест-генерация в панели или триггер по regex.

**Механика:** workflow хранятся как `{имя: {data, nodeId, outputNodeId}}` — **конфиг ID per workflow**, применяется при переключении пресетов (SDXL-реализм/аниме/SD1.5). Промпт — в первый текстовый вход из whitelist `["text","opt_text","string","text_positive","positive","prompt","wildcard_text"]`.

**Автопоиск** только для выхода (первая `images[]` из history). Вход — полностью ручной; списков с сервера и валидации до отправки нет. FAQ описывает типовую поломку: «неправильный ID → картинка вся в шумах/чёрная». Фишки: тест-бокс в панели, inline/replace-режимы, миграция настроек.

### 4. TTWParty/SillyTavern-RBQ-Draw

Репо: https://github.com/TTWParty/SillyTavern-RBQ-Draw (бандл минифицирован — механика по UI-строкам + README).

**Флоу:** режим ComfyUI в «консоли» → импорт workflow **.json или .png** → авто-распознавание → правка маппинга дропдаунами → генерация.

**Импорт — самый проработанный:**
- принимает **PNG, сгенерированный ComfyUI** (workflow в метаданных PNG); нет метаданных — явная ошибка;
- детект UI-графа с двумя путями исправления: «включите Dev Mode → Save (API)» **или «просто импортируйте PNG, созданный этим workflow»** — обход главного барьера входа;
- после импорта — авто-скан топологии и toast-отчёт: «распознано и привязано: позитив (Node 6), негатив (Node 7), сэмплер (Node 3)…».

**Эвристики:** текстовые ноды по `class_type` (`CLIPTextEncode|Prompt|Text`) или строковым `text/positive/prompt`; позитив/негатив — по заголовку (`/neg|反向|负面/`) **и по содержимому** (`worst quality|lowres` → негатив; `masterpiece|1girl` → позитив); latent — `EmptyLatent` или width+height; модель — `CheckpointLoader|UNETLoader|ckpt_name|unet_name`; выход — `SaveImage|filename_prefix`.

**Панель маппинга:** дропдауны ролей (positive/negative/sampler/latent/model/saveImage/filename) с опцией «не указано / оставить как в workflow»; кнопка «умное пересканирование» — ответ на боль «сломалось после правки графа».

**Плейсхолдеры:** `{{prompt}}`… `{{seed}}` + **таблица китайских алиасов** (`"正向提示词"`, `"宽度"`…) — workflow китайских авторов работают без правки JSON.

**Модель-защита:** чекбокс «перезаписывать модель workflow моделью ST (по умолчанию выключен)»; overrideSeed/Size/Sampler = on, overrideModel = off.

### 5. orangewoker/SillyTavern-ComfyUI-Bridge

Репо: https://github.com/orangewoker/SillyTavern-ComfyUI-Bridge (`core.js` — чистая тестируемая логика + тесты).

**Флоу:** URL + тест → «импортировать как workflow» (несколько файлов = профили) → проверить **автосгенерированный маппинг** → значения уже подставлены из workflow → запуск.

**Сильнейшая механика маппинга:** декларативная `PARAMETER_DEFS` (10 параметров) с `inputNames`/`classes`/`titleWords`. `inferMappings` собирает **все** примитивные входы (пути `271.text`), а промпт ищет **обходом графа от KSampler.positive/negative** сквозь цепочки кастомных нод (CR Text → CLIPTextEncode → KSampler); `ConditioningZeroOut` на негативе = «негатива намеренно нет».

**UI маппинга:** на параметр — дропдаун всех примитивных входов в формате `271.text · CR Text · заголовок = "текущее значение"`; при импорте **актуальные значения читаются в форму** — пользователь подтверждает, а не заполняет с нуля.

**Подстановка гибридная:** маппинги (с типо-коэрцией) → плейсхолдеры `{{key}}`/`%key%` → ST-макросы. Ошибки: `formatComfyError` разворачивает `node_errors` в «узел 3: <message>»; README с таблицей «быстрая диагностика подключения».

### 6. krisshen2021/enhanced-comfyui-generator (ECG)

Репо: https://github.com/krisshen2021/enhanced-comfyui-generator.

**Единственный с настоящим графическим редактором внутри ST:** LiteGraph.js в модалке — создавать/импортировать/соединять ноды; loadImage-нода грузит картинку на `/upload/image` с превью; виджеты из `/object_info`; **«Test Run»** — прогон с прогрессом до сохранения. Списки с фолбэком на дефолты при CORS-ошибке («редактор всё равно работает»). Плейсхолдеры: `%prompt% %width% %height% %seed% %timestamp% %image_name% %input_image_url%`. Уникально: два URL (основной + видео).

### 7. chen854730532/SillyTavern-ComfyUI-Illustrator

Репо: https://github.com/chen854730532/SillyTavern-ComfyUI-Illustrator — ближайший аналог URIS: textarea «вставь API-JSON», проверка `includes('%prompt%')` при генерации, замена с экранированием, `JSON.parse` после подстановки. Всё остальное — руками.

### 8. Spadic21/ComfyInject (кратко)

Репо: https://github.com/Spadic21/ComfyInject — workflow поставляется файлом в составе расширения; пользователь выбирает имя; чекпойнт — поле с автокомплитом «Show available checkpoints».

## (b) Сводная таблица

| Возможность | ST ядро | Imagine | Simplified | RBQ-Draw | Bridge | ECG | Illustrator |
|---|---|---|---|---|---|---|---|
| Редактор графа (не textarea) | — | — | — | — | — | **Да (LiteGraph + Test Run)** | — |
| Списки из сервера (/object_info) | модели(+UNet/GGUF)/сэмплеры/шедулеры/VAE | только LoRA | — | чекпойнты/сэмплеры/шедулеры | — (только тест) | да + fallback | — |
| Автопоиск нод | — | фолбэк CLIPTextEncode + титулы | только выход | **да, топология + эвристики** | **да, обход графа от KSampler** | — | — |
| Маппинг по ID/пути | — (плейсхолдеры) | титулы IMAGINE_* | ручной ID | дропдауны ролей | **дропдауны `nodeId.input`** | — | — |
| Кастомные плейсхолдеры | find/replace + макросы | — | — | {{}} + алиасы | {{}} + %% + макросы | фикс. набор | %prompt%/%seed% |
| Валидация до отправки | индикатор плейсхолдеров | детект UI-формата | «нода существует» | формат-детект + пер-нодовые | формат-детект + node_errors | Test Run | только %prompt% |
| Пресеты/мультиворкфлоу | да + slash | да | да, per-workflow ID | да (+PNG) | да (профили) | да | — |
| Чтение значений в форму | — | — | — | частично | **да** | — | — |

## (c) Приёмы, которые стоит позаимствовать

1. **Живой индикатор плейсхолдеров рядом с textarea** (ST ядро): `%…%` с меткой найден/не найден, пересчёт на каждый ввод. Дёшево, отвечает «я всё правильно вставил?» до генерации.
2. **Детект «не того формата» + два пути исправления** (RBQ-Draw/Imagine/Bridge): инструкция Dev Mode → Export (API) **или импорт PNG, созданного этим workflow**.
3. **Авто-распознавание нод при импорте + toast-отчёт + дропдауны переназначения** (RBQ-Draw/Bridge): «промпт → Node 6 (CLIPTextEncode)», кнопка «пересканировать».
4. **Поиск промпт-ноды обходом графа от KSampler**, а не фиксированным ID (Bridge): работает со wrapper-нодами; именно на «ID по порядку» ломается Simplified.
5. **Читать текущие значения workflow в форму при импорте + модель-защита** (Bridge/RBQ-Draw): настройка как подтверждение, а не анкета.
6. **Список моделей из `/object_info`** (модели+UNet+GGUF одним запросом, человекочитаемые имена) + graceful fallback (ECG).
7. **Ошибки по нодам с class_type** — и из `node_errors` (валидация, до очереди), и из `history.status.messages` (исполнение).
8. **Титул-конвенции как канал нулевой конфигурации** (Imagine `IMAGINE_*`) + нейтрализация незадействованных нод + фолбэк-цепочка записи `text → value → widgets_values[0]`.
9. **Бонус:** slash-команды переключения workflow; переименование пресетов (ST [#5120](https://github.com/SillyTavern/SillyTavern/issues/5120)).

### Боли из issues (обоснование)

- «Не тот формат экспорта» — инструкции в README Imagine/Bridge/Illustrator.
- «Промпт не туда → шум/чёрная картинка» — FAQ Simplified.
- Плейсхолдер заменялся один раз — [ST #2460](https://github.com/SillyTavern/SillyTavern/issues/2460) (нужен replaceAll).
- «Нет моей модели в списке» (GGUF) — [ST #3088](https://github.com/SillyTavern/SillyTavern/issues/3088).
- «Хочу кастомные входы» — [ST #2060](https://github.com/SillyTavern/SillyTavern/issues/2060).
- «Не найти выход» при нестандартных output-нодах — [ST #5890](https://github.com/SillyTavern/SillyTavern/issues/5890), #5815.
- «Успех, но нет результата» / «только первая картинка» — README Bridge.
- Дефолтный workflow был сломан — [ST #2322](https://github.com/SillyTavern/SillyTavern/issues/2322).
