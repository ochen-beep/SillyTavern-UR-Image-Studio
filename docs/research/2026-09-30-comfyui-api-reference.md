# ComfyUI (self-hosted, открытый сервер): HTTP/WebSocket API — справка для внешнего JS-клиента

> Исследование от 2026-09-30 (агент). Метод проверки: факты сверены с актуальным кодом `master` (server.py, protocol.py, execution.py, app/user_manager.py, comfy_execution/progress.py, custom_nodes/websocket_image_save.py, comfy/samplers.py, script_examples) и с официальной документацией docs.comfy.org (раздел Development → ComfyUI Server).

Главные страницы документации:
- Обзор сервера: https://docs.comfy.org/development/comfyui-server/comms_overview
- Роуты: https://docs.comfy.org/development/comfyui-server/comms_routes
- WS-сообщения: https://docs.comfy.org/development/comfyui-server/comms_messages
- Примеры кода: https://docs.comfy.org/development/comfyui-server/api-examples
- Флаги запуска: https://docs.comfy.org/development/comfyui-server/startup-flags
- Формат workflow API: https://docs.comfy.org/development/api-development/workflow-api-format
- Ключ API-нод: https://docs.comfy.org/development/comfyui-server/api-key-integration

---

## 1. HTTP-эндпоинты (проверено по server.py master)

Базовый адрес: `http://127.0.0.1:8188`.

**Алиас `/api`: ДА.** В `server.py → add_routes()` каждый роут дублируется с префиксом `/api` («Currently both the old endpoints without prefix and new endpoints with prefix are supported»). Т.е. `/prompt` == `/api/prompt`, `/view` == `/api/view`, `/models/checkpoints` == `/api/models/checkpoints` и т.д.

### Очередь и выполнение

| Метод и путь | Тело / параметры | Ответ |
|---|---|---|
| `POST /prompt` | `{"prompt": {...api-формат...}, "client_id": "...", "prompt_id": "<uuid4>?", "extra_data": {...}, "front": bool?, "number": float?, "partial_execution_targets": [...]?}` | `200 {"prompt_id": "...", "number": N, "node_errors": {...}}`; при ошибке валидации `400 {"error": {"type","message","details","extra_info"}, "node_errors": {...}}` |
| `GET /prompt` | — | `{"exec_info": {"queue_remaining": N}}` (текущее состояние очереди) |
| `GET /queue` | — | `{"queue_running": [...], "queue_pending": [...]}`; элементы кортежа `[number, prompt_id, prompt, extra_data, outputs_to_execute]` (секретные extra_data вырезаны) |
| `POST /queue` | `{"clear": true}` и/или `{"delete": ["<prompt_id>", ...]}` | `200` пусто |
| `POST /interrupt` | тело опционально; `{}` = глобальный interrupt, **`{"prompt_id": "..."}` = прицельная отмена (новое в 2025–26)** | `200` |
| `POST /free` | `{"unload_models": bool, "free_memory": bool}` | `200` |
| `GET /history` | `?max_items=N&offset=N` | `{prompt_id: {prompt: [...], outputs: {...}, status: {...}}}` |
| `GET /history/{prompt_id}` | — | то же, словарь с одним ключом |
| `POST /history` | `{"clear": true}` / `{"delete": [ids]}` | `200` |

**Новый REST-слой задач (2026), под `/api/jobs`:**

- `GET /api/jobs?status=pending,in_progress,completed,failed&workflow_id=&sort_by=created_at|execution_duration&sort_order=asc|desc&limit=&offset=` → `{"jobs": [...], "pagination": {"offset","limit","total","has_more"}}`
- `GET /api/jobs/{job_id}` → одна задача или 404
- `POST /api/jobs/{job_id}/cancel` → идемпотентно `{"cancelled": bool}` (running — interrupt, pending — снятие с очереди)
- `POST /api/jobs/cancel` → `{"job_ids": [uuid...]}`, best-effort batch

Это «чистый» API поверх очереди, но классический цикл `POST /prompt` + WS всё равно основной.

### Картинки и файлы

- `GET /view?filename=&subfolder=&type=&channel=&preview=` — тип: `output` (по умолчанию) | `temp` | `input`. Доп.: `channel=rgb|a` (сервер перекодирует в PNG), `preview=webp|jpeg;<quality>` (перекодирование превью), `format=png|jpeg|webp`. В 2026 добавлено разрешение `blake3:`-хэшей ассетов. Ответ — бинарные данные; для «опасных» типов (svg/html) отдаётся `Content-Disposition: attachment`.
- `POST /upload/image` — multipart/form-data: `image` (файл), `overwrite` (`true`/`false`; иначе имя получает суффикс « (1)», дубликаты по хэшу не создаются), `subfolder`, `type=input|temp|output`. Ответ: `{"name","subfolder","type"[, "asset": {...}]}`. `POST /upload/mask` — то же + `original_ref` (JSON текущей картинки; альфа-канал заменяется маской).
- `GET /view_metadata/{folder}?filename=*.safetensors` — JSON `__metadata__` из safetensors.

### Схемы нод и модели

- `GET /object_info` — все ноды (большой ответ). `GET /object_info/{node_class}` — одна нода; **неизвестный класс возвращает `{}` с 200, а не 404** — проверяйте наличие ключа.
- Формат (v1): `{class: {input: {required: {...}, optional: {...}, hidden: {...}}, input_order: {...}, is_input_list, output: [types], output_is_list, output_name, output_tooltips, name, display_name, description, python_module, category, output_node, deprecated, experimental, api_node, search_aliases, essentials_category, ...}}`.
- **Важно про `input_required`:** на сервере ключ — `input.required` (см. `node_info()` в server.py и `get_v1_info()`/`NodeInfoV1` в comfy_api). `input_required/input_optional/input_hidden` — это нормализованное представление уже во фронтенде/клиентских библиотеках. Парсите `obj.input.required.ckpt_name`.
- **Список чекпойнтов:** `GET /object_info/CheckpointLoaderSimple` → `{"CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": ["model1.safetensors", "model2.safetensors", {tooltip...}]}}}}` — список файлов это массив `input.required.ckpt_name` (последний элемент, если это объект, — опции). Проще: `GET /models/checkpoints`.
- `GET /models` → список типов папок (checkpoints, loras, vae, controlnet, upscale_models, ...); `GET /models/{folder}` → файлы. `GET /embeddings` → имена эмбеддингов без расширений.
- Сэмплеры/шедулеры для KSampler: `GET /object_info/KSampler` → `input.required.sampler_name[0]` и `input.required.scheduler[0]` (списки из `comfy/samplers.py`: `euler, euler_ancestral, heun, dpmpp_2m, dpmpp_2m_sde, dpmpp_3m_sde, lcm, uni_pc, ddim, ...`; шедулеры `simple, sgm_uniform, karras, exponential, ddim_uniform, beta, normal, linear_quadratic, kl_optimal`).

### Служебные

- `GET /system_stats` → `{"system": {"os", "ram_total", "ram_free", "comfyui_version", "required_frontend_version", "installed_templates_version", "required_templates_version", "comfy_package_versions", "python_version", "pytorch_version", "embedded_python", "argv"}, "devices": [{"name","type","index","vram_total","vram_free","torch_vram_total","torch_vram_free"}]}` — удобно для health-check и показа версии.
- `GET /features` — серверные feature-флаги (`supports_preview_metadata`, `supports_model_type_tags`, `max_upload_size`, ...).
- `/userdata` (папка пользователя, `<user>/userdata`): `GET /userdata?dir=&recurse=true&full_info=true&split=true`; `GET /v2/userdata?path=` (структурированный список файлов/папок — новинка); `GET /userdata/{file}` (файл, отдаётся attachment, кроме user.css); `POST /userdata/{file}?overwrite=&full_info=` (тело — сырые байты; 409 если overwrite=false и файл есть); `DELETE /userdata/{file}`; `POST /userdata/{file}/move/{dest}`. Подходит, чтобы сохранять пресеты настроек расширения на сервере ComfyUI.
- `GET/POST /users` — информация/создание пользователя (только в `--multi-user`).
- `GET /extensions` — JS-расширения; `GET /workflow_templates` (`/api/workflow_templates`) — шаблоны из custom-нод.

## 2. WebSocket `/ws?clientId=<uuid>`

- Подключение: `new WebSocket("ws://127.0.0.1:8188/ws?clientId=" + uuid)` — тот же `client_id`, что и в `POST /prompt`. Если clientId уже занят, старый сокет удаляется и заменяется.
- При подключении сервер сразу шлёт `{"type":"status","data":{"status":{"exec_info":{"queue_remaining":N}},"sid":"<sid>"}}`. Если под этим sid прямо сейчас идёт выполнение, сервер повторно пришлёт `executing` с текущей нодой — **восстановление после обрыва работает**: просто переподключитесь с тем же clientId.
- Весь текст — JSON-конверт `{"type": <event>, "data": {...}}`; у lifecycle-сообщений в `data` добавляется `timestamp` (мс).

Типы сообщений (сервер → клиент):

| type | data | Кому |
|---|---|---|
| `status` | `{"status": {"exec_info": {"queue_remaining": N}}}` (+ `sid` только в приветствии) | всем (broadcast) |
| `execution_start` | `{"prompt_id"}` | инициатору |
| `executing` | `{"node": "<id>" \| null, "display_node", "prompt_id"}`; **`node: null` = выполнение данного prompt_id завершено** | инициатору |
| `executed` | `{"node", "display_node", "output": {images: [{filename, subfolder, type}], ...}, "prompt_id"}` | инициатору |
| `progress` (легаси) | `{"node", "prompt_id", "value", "max", "quality", "step"}` | инициатору |
| `progress_state` (новый) | `{"prompt_id", "nodes": {"<id>": {"value","max","state","node_id","prompt_id","display_node_id","parent_node_id","real_node_id"}}}` | инициатору |
| `execution_cached` | `{"prompt_id", "nodes": ["<id>", ...]}` — кэшированные ноды, которые будут пропущены | инициатору |
| `execution_success` | `{"prompt_id", "timestamp"}` | инициатору |
| `execution_error` | `{"prompt_id","node_id","node_type","executed":[...],"exception_message","exception_type","traceback":[...],"current_inputs","current_outputs"}` | инициатору |
| `execution_interrupted` | `{"prompt_id","node_id","node_type","executed"}` | всем |
| `feature_flags` | серверные флаги | в ответ на первое сообщение клиента |

- **Feature-флаги:** первым сообщением клиент может прислать `{"type":"feature_flags","data":{"supports_preview_metadata": true}}` — сервер ответит `feature_flags` и начнёт слать бинарные превью нового формата (event 4). Без флага — старый формат (event 1).
- **Бинарные фреймы:** первые 4 байта — big-endian uint32 event type (`protocol.py`): `1` = PREVIEW_IMAGE, `2` = UNENCODED_PREVIEW_IMAGE, `3` = TEXT, `4` = PREVIEW_IMAGE_WITH_METADATA. Для превью (event 1): далее 4 байта big-endian тип картинки (`1`=JPEG, `2`=PNG) и сами байты — итого «8-байтовый заголовок», картинка = `frame.slice(8)`. Event 3 (лог-текст ноды): 4 байта длины node_id + node_id + текст. Event 4: 4 байта длины JSON-метаданных + JSON (`node_id`, `prompt_id`, ..., `image_type`) + байты картинки.
- `SaveImageWebsocket` — встроенный bundled custom-node (`custom_nodes/websocket_image_save.py`), шлёт полноразмерные PNG тем же форматом превью; `history` для него пустая (только WS). Для интеграции проще обычный `SaveImage` + `GET /view`.
- Завершение: надёжный детект — `executing` с `node === null` и вашим `prompt_id`, либо `execution_success`/`execution_error`/`execution_interrupted`; затем `GET /history/{prompt_id}`.

Официальный пример: https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/websockets_api_example.py

## 3. Формат workflow JSON

- **UI-формат** («Workflow → Save»): `{nodes: [{id, type, inputs, widgets_values, pos, ...}], links: [...], groups, version}` — для рендеринга графа.
- **API-формат** («Workflow → Export (API)», раньше «Save (API Format)»): плоский словарь по строковым ID нод; координаты/цвета/группы выброшены:

```json
{
  "4":  { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" }, "_meta": {"title": "Load Checkpoint"} },
  "6":  { "class_type": "CLIPTextEncode", "inputs": { "text": "beautiful scenery...", "clip": ["4", 1] }, "_meta": {"title": "Prompt"} },
  "3":  { "class_type": "KSampler", "inputs": { "seed": 156680208700286, "steps": 20, "cfg": 8.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] }, "_meta": {"title": "KSampler"} },
  "9":  { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] }, "_meta": {"title": "Save Image"} }
}
```

- Ссылка на выход другой ноды = `["<node_id>", <индекс_выхода>]` (у CheckpointLoaderSimple выходы 0=MODEL, 1=CLIP, 2=VAE — см. `output` в object_info).
- **Параметризация** — просто перезаписывайте скаляры в `inputs`: `prompt.nodes["6"].inputs.text = promptText; prompt.nodes["3"].inputs.seed = Math.floor(Math.random() * 2**53)` (у seed `max = 0xffffffffffffffff`). Аналогично `ckpt_name`, `width/height/batch_size` (EmptyLatentImage), `steps/cfg/denoise`.
- **`control_after_generate`/randomize** — это подсказка виджету фронтенда: в object_info у seed стоит `"control_after_generate": true`, и UI добавляет контролы randomize/increment/decrement/fix. Сервер ничего не рандомизирует: используется ровно то число, что прислали. API-клиент обязан генерировать seed сам.
- **Кастомные ноды:** `class_type` обязан существовать в `NODE_CLASS_MAPPINGS`, иначе `validate_prompt` вернёт 400 с `node_errors`. Перед отправкой проверяйте наличие классов через `GET /object_info/{class}`, а значения combo — по спискам из object_info. Риск: workflow, экспортированный с установленными кастом-нодами (например, LoRA-стеками от Impact/Easy-Use), не запустится на машине без них.
- **Где описано:** https://docs.comfy.org/development/api-development/workflow-api-format (export, структура inputs/`_meta`, примеры KSampler/CLIPTextEncode). Система шаблонов: built-in пакеты в репо `Comfy-Org/workflow_templates` (pip-пакет `comfyui-workflow-templates`, версия видна в `/system_stats` как `installed_templates_version`; UI-формат JSON, фронтенд конвертирует при запуске); шаблоны кастом-нод — https://docs.comfy.org/custom-nodes/workflow-templates и эндпоинт `/api/workflow_templates`. Библиотека готовых workflow — https://comfy.org/workflows.

## 4. Конфигурация сервера, критичная для браузерного клиента

- Порт/адрес: по умолчанию `127.0.0.1:8188`; `--listen 0.0.0.0` (или список адресов; без значения = `0.0.0.0,::`), `--port N`.
- **CORS — главный пункт:** без спец. флага включён `origin_only_middleware`, который **возвращает 403** для запросов с `Sec-Fetch-Site: cross-site` и для запросов, где `Host` (`127.0.0.1:8188`) не совпадает с `Origin` (например, `http://127.0.0.1:8000` SillyTavern). Это анти-CSRF мера для loopback — то есть **fetch из браузера с другого порта по умолчанию будет заблокирован (включая WS-хендшейк)**. Запускайте ComfyUI с `--enable-cors-header "*"` (или конкретным origin); middleware выставляет `Access-Control-Allow-Origin`, `Allow-Methods: POST, GET, DELETE, PUT, OPTIONS, PATCH`, `Allow-Headers: Content-Type, Authorization`, `Allow-Credentials: true`.
- Авторизация: **встроенной аутентификации нет** (никаких basic/token). `--multi-user` включает лишь раздельное хранилище пользователей (/users, /userdata). Защита — обычно reverse proxy (nginx/caddy) с basic auth или bind на localhost.
- TLS: `--tls-certfile` + `--tls-keyfile` (сервер станет HTTPS). Учтите mixed content: страница https (SillyTavern) не сможет фетчить `http://127.0.0.1` — Chrome блокирует с исключениями для localhost (Private Network Access), но это надо тестировать.
- Прочее: `--quick-test-for-ci` (старт и выход), `--max-upload-size` (МБ, по умолчанию 100), `--front-end-version`, `--enable-manager` (Manager UI), `--disable-api-nodes` (отключить платные API-ноды + CSP `default-src 'self'`).
- Не путать: **локальный сервер ComfyUI** (этот API, бесплатно, ваши модели) и **облачный «Comfy API» / Comfy Cloud** (`api.comfy.org`, OpenAPI v2 https://docs.comfy.org/openapi-v2.yaml, платные «API nodes» — Flux от BFL, GPT-Image и т.п.). Локально API-ноды работают, только если передан ключ: `extra_data.api_key_comfy_org` (раньше было `api_key`) в `POST /prompt`; секретные ключи (`SENSITIVE_EXTRA_DATA_KEYS = ("auth_token_comfy_org", "api_key_comfy_org")`) вырезаются из extra_data и не показываются в `/queue` и `/api/jobs`. Шаблоны с `class_type: "api_..."` без ключа выдадут ошибку исполнения.

## 5. Свежие изменения (2024–2026), важные клиенту

- Новый фронтенд (Comfy-Org/ComfyUI_frontend, Vue) — late 2024; старые пути `/scripts/ui`, `/extensions/core/*` помечены deprecation-warning middleware.
- **Префикс `/api`** продублирован для всех роутов (для dev-server проксирования).
- **`/api/jobs*`** — новый пагинированный REST по задачам + идемпотентная отмена (2026).
- **`/interrupt` принял опциональный `prompt_id`** (прицельная отмена); `POST /prompt` теперь **валидирует `prompt_id` как канонический lowercase-UUID** (иначе 400 `invalid_prompt_id`) — генерируйте `crypto.randomUUID()`.
- **Флаг-неготиация по WS** + бинарный event `4` (превью с метаданными) и текстовое событие `progress_state`.
- `/v2/userdata`, `/features`, блейк3-ассеты в `/view` и `/upload/image` (`--enable-assets`).
- Переименование ключей API-ключей в extra_data (`api_key` → `api_key_comfy_org`, `auth_token_comfy_org`).
- Шаблоны вынесены в pip-пакет `comfyui-workflow-templates` (версии в `/system_stats`); версионирование самого ComfyUI: теги вида `v0.38.0` (patch = бэкпорты в stable).
- Раздел документации для этих тем: https://docs.comfy.org/development/comfyui-server/comms_overview (полный индекс — https://docs.comfy.org/llms.txt). Прежних страниц `/essentials/...` про сервер больше нет — структура документации менялась, ориентируйтесь на пути `/development/...`.

## Подводные камни (сводка для расширения SillyTavern)

1. Без `--enable-cors-header "*"` браузерный fetch/WS с другого origin/порта получит 403 — первая причина «не работает» у интеграций.
2. `prompt_id` обязан быть UUID lowercase с дефисами; удобно использовать `crypto.randomUUID()` и коррелировать со своими задачами.
3. `/history/{id}` возвращает `{prompt_id: {...}}` — не забудьте взять `[prompt_id]`; поле `outputs` пустое, пока выполнение не завершилось (и всегда пустое при использовании SaveImageWebsocket).
4. Картинку из `outputs.images[i]` берите через `/view?filename=&subfolder=&type=` — все три поля обязательны; для «temp» картинок (превью) файлы чистятся.
5. Seed фронтендом не рандомизируется на сервере — генерируйте сами (0 … 2^64−1; безопасно использовать 2^53).
6. Ключ object_info — `input.required.*`, не `input_required`; неизвестная нода в object_info возвращает `{}`, а не 404.
7. Кэширование исполнения: при повторной отправке того же графа ноды попадут в `execution_cached` и новые `executed`-события не придут — финал определяйте по `executing{node:null}` / `execution_success`.
8. Компрессия JSON (`--enable-compress-response-body`, gzip по `Accept-Encoding`) и `max_upload_size` (100 МБ) — учтите при больших upload'ах.
