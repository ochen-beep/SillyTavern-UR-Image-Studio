# Паттерны «ComfyUI-workflow → настраиваемый продукт»

> Исследование от 2026-10-01 (агент). Спутниковый отчёт к [синтезу улучшений](2026-10-01-comfy-provider-improvements.md). Sources в конце.

## Вводная про форматы

- **UI-формат** (Save) — полный граф: `nodes[]` с `pos`, `widgets_values`, связями; в сид-виджете сидит `control_after_generate` (`fixed/increment/decrement/randomize`) — **чисто фронтендная** логика.
- **API-формат** (Export API / `/prompt`) — плоский словарь: `{id: {inputs, class_type, _meta}}`; значения входов — скаляры или ссылки `["<node_id>", output_index]`. `control_after_generate` в API-формат **не попадает**. `_meta.title` экспортится всегда и пригоден для автогенерации форм.

Следствие: **рандомизацию seed клиент делает сам**, подменяя число перед отправкой.

## (a) Инвентарь паттернов

### П1. Автоскан API-JSON + sidecar-конфиг (ViewComfy)
Параметры вычисляются сканом `workflow_api.json`; автор может разметить ноды префиксами в `_meta.title` (`VC_BASIC_…`/`VC_ADV_…`). Маппинг — отдельный `view_comfy.json`: каждый инпут содержит `workflowPath: ["6","inputs","text"]`. Тип выводится по значению (`typeof`: string/number/float/bigint/boolean) + спец-типы по `class_type`: `CLIPTextEncode` → long-text; `LoadImage/LoadImageMask` → image; заголовок с `seed|noise_seed|rand_seed` → seed. Контролы: string, long-text, number, bigint, float, boolean, seed, select (options), image/video/audio, slider {min,max,step}. Валидации required, helpText/tooltip/placeholder, группировка basic/advanced.

### П2. Input-ноды в графе (ComfyDeploy, Comfy-Pack/BentoML)
Параметр — **отдельная нода**: `ComfyUIDeployExternalText/TextAny/Image/Number(NumberInt/Slider)/Boolean/Checkpoint/Lora/VideoXVHS`, `CPackInputInt/String/File`. Общие поля: `input_id`, `default_value`, `display_name`, `description`. Платформа находит ноды по `class_type` и передаёт `inputs: {input_id: value}`. Маппинг переживает правки графа; минус — нужны кастом-ноды.

### П3. Официальный App Mode (фронтенд ≥ 1.41.13, 2026)
Входы задаются кликом по нодам на канвасе (builder: inputs → outputs → preview → default view); конфиг хранится с workflow; контролы — сами виджеты нод. Шеринг через URL (пока только Comfy Cloud). Логика завязана на фронтенд ComfyUI, не на API-JSON — в браузерное расширение непереносима без парсинга UI-формата.

### П4. Официальные шаблоны (Comfy-Org/workflow_templates)
Шаблон = UI-формат JSON + миниатюра + запись в `templates/index.json`; внутри `properties.models` на loader-нодах (name/url/SHA256/directory) и `cnr_id`/`ver` для пининга нод. Механизма «вопросов пользователю» нет. Урок: метаданные живут в properties графа, описания — во внешнем индексе.

### П5. Программные DSL
**@stable-canvas/comfyui-client** (JS, zero-deps, **браузер**): `wf.node("CheckpointLoaderSimple")`, деструктуризация outputs, `.inputs({...})`; есть транспайлер JSON → код. **ComfyScript** — Python-фронтенд (требует Python → непереносим). Для подстановки параметров в готовый API-JSON сборка кодом избыточна.

### П6. Матчинг по `_meta.title` (comfy-toolkit, SaladTech comfyui-api)
Замена значений в нодах, найденных по заголовку (case-insensitive), без жёстких ID: «нода с заголовком *Positive Prompt*» → текст. Соглашение об именах вместо конфига; ~50 строк кода.

### П7. Ноды-инжекторы рантайма (ComfyUI-Easy-Use)
`easy globalPrompt` прокидывает промпты во все «пустые» входы easy-семплеров; `easy setNode` переопределяет ноды по ID при запуске. Привязано к экосистеме Easy-Use.

## (b) Переносимость в браузерное расширение

| Паттерн | Что нужно (без сервера) | Оценка |
|---|---|---|
| П1 Автоскан + sidecar | Парсер API-JSON (~200 строк): перебор `{id, class_type, inputs}`, эвристики по class_type/имени входа/typeof; хранение `{workflowPath, type, title, value}` рядом с workflow. Замена = `wf[path[0]].inputs[path[2]] = v`. Реф-изображения — `/upload/image` | Средне; офлайн |
| П2 Input-ноды | Только *распознавание* чужих нод + чтение `input_id`/`default_value` для формы | Дёшево как импорт |
| П3 App Mode | Парсить UI-JSON + app-конфиг — хрупко | Не рекомендуется |
| П5 stable-canvas | npm-пакет, браузерно; полезен как клиент, не для подстановки | Опционально |
| П6 Матч по title | Сравнение `_meta.title`/имён входов с токенами | ~50 строк |
| Seed/control_after_generate | Клиент генерирует seed сам; «fixed» — по желанию | Обязательно |
| Валидация select/слайдеров | Допустимые combos из `/object_info` (`input.required`) | ~1 запрос |

## (c) Рекомендация для URIS

1. **Базовый слой — автоскан API-JSON** (П1 без sidecar-редактора): при импорте построить форму из кандидатов — `CLIPTextEncode`-входы → long-text с `_meta.title`; `*seed*` → контрол seed (randomize/fixed); `LoadImage` → аплоад референса; числа → number; списки из `/object_info` → select. Маппинг хранить как `{nodeId, input, type, title}` рядом с workflow.
2. **Слой разметки — матч по `_meta.title`** (П6): расширение сначала ищет ноды, переименованные под токены (`%prompt%`, «prompt», «seed», «reference»), — пользователь размечает workflow переименованием нод в ComfyUI, JSON руками не трогает.
3. **Совместимость — импорт input-нод** (П2): `ComfyUIDeployExternal*`/`CPackInput*` показывать в форме с `display_name`/`default_value` (~100 строк).

Отпасть: воспроизведение App Mode (П3), ComfyScript/DSL (П5). `@stable-canvas/comfyui-client` — опционально как клиент, подстановка в готовом API-JSON делается присваиванием по пути.

## Sources

[ViewComfy](https://github.com/ViewComfy/ViewComfy) · [правила view_comfy.json](https://raw.githubusercontent.com/ViewComfy/ViewComfy/main/.cursor/rules/view-comfy-json-rules.mdc) · [workflow-api-parser.ts](https://raw.githubusercontent.com/ViewComfy/ViewComfy/main/lib/workflow-api-parser.ts) · [ComfyDeploy inputs](https://docs.comfydeploy.com/docs/api/inputs) · [ComfyUIDeployExternalText](https://comfy.icu/node/ComfyUIDeployExternalText) · [ComfyUI App Mode](https://docs.comfy.org/interface/app-mode) · [анонс App Mode](https://blog.comfy.org/p/from-workflow-to-app-introducing) · [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates) · [формат API-JSON](https://docs.comfy.org/zh/development/api-development/workflow-api-format) · [@stable-canvas/comfyui-client](https://github.com/StableCanvas/comfyui-client) · [ComfyScript](https://github.com/comfyorg/comfyscript) · [comfy-toolkit](https://pypi.org/project/comfy-toolkit/) · [CPackInputInt](https://comfy.icu/node/CPackInputInt) · [BentoML ComfyUI](https://docs.bentoml.com/en/latest/examples/comfyui.html) · [comfyui-api (SaladTech)](https://github.com/SaladTechnologies/comfyui-api) · [ComfyUI-Easy-Use](https://github.com/yolain/ComfyUI-Easy-Use) · [разбор control_after_generate](https://ajimenez.dev/blog/comfyui-as-production-api/) · [ComfyUIOps](https://comfyuiops.com)
