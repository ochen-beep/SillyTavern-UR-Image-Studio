# Server Image Connections Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести OpenAI Images, Gemini Native и OpenRouter Images на обязательный server plugin с простым UX `endpoint + key → models → generate`, сохранив текущий Stage 1/Stage 2/gallery pipeline и legacy Agnes/Pollinations.

**Architecture:** Реализация разбита на четыре независимых плана. Сначала создаётся безопасный server foundation, затем adapters и durable generation journal, после этого клиент подключается к готовому server API, и только затем выполняются миграция ключей, export/import и отключение старых browser OpenAI/Gemini paths.

**Tech Stack:** SillyTavern server plugins, Node.js >=20 ESM, vanilla browser ES modules, `node:test`, SillyTavern `SecretManager`, `write-file-atomic`, `node-fetch`, localforage.

**Spec:** `docs/superpowers/specs/2026-07-27-server-image-api-connections-design.md`

---

## Execution model for GLM 5 Turbo

Эта работа должна выполняться через `superpowers:subagent-driven-development`.

Для каждой задачи контролирующий агент:

1. запускает свежего GLM 5 Turbo subagent только с одной commit-sized задачей, зависимыми контрактами и точными файлами; если дочерний план исторически содержит два commit steps под одним номером, каждый commit step является отдельной dispatch/review unit и получает нового implementer;
2. требует TDD: новый тест сначала падает по ожидаемой причине;
3. после реализации запускает отдельный spec-compliance review subagent;
4. затем запускает отдельный code-quality review subagent;
5. исправляет замечания тем же implementer subagent или новым узким fix subagent;
6. запускает targeted tests и regression delta check;
7. делает один логический commit;
8. только после этого переходит к следующей задаче.

Не давать одному subagent весь master plan. Для GLM 5 Turbo это слишком большой контекст. Передавать только один task из дочернего плана плюс определения типов, созданные предыдущими задачами.

## Worktree and baseline precondition

Текущая `main` dirty и содержит незавершённые изменения, пересекающиеся с будущими hotspot-файлами. Реализацию нельзя начинать в текущем рабочем каталоге.

При начале выполнения:

- использовать `superpowers:using-git-worktrees`;
- сначала сохранить текущую dirty-работу способом, одобренным пользователем;
- создать feature worktree/branch от точки, включающей нужные текущие Pollinations/model changes;
- не откатывать существующие изменения Pollinations;
- записать baseline test output до feature commits.

Baseline and full-suite command (works in the supported Windows Git Bash environment and explicitly includes both root and nested provider tests):

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

На момент планирования известны 14 legacy failures в `references-profiles.test.js`. До отдельного release cleanup gate правило такое:

```text
новая задача допустима, если её targeted tests green,
а число и состав baseline failures не выросли.
```

Subagent не должен самовольно чинить или удалять эти 14 tests внутри feature-задач.

## Plan set

Выполнять строго в этом порядке:

1. `docs/superpowers/plans/2026-07-27-server-image-connections-1-foundation.md`
2. `docs/superpowers/plans/2026-07-27-server-image-connections-2-adapters-generation.md`
3. `docs/superpowers/plans/2026-07-27-server-image-connections-3-client.md`
4. `docs/superpowers/plans/2026-07-27-server-image-connections-4-migration-release.md`

## Phase gates

### Gate A — Server foundation

Перед adapters должны быть green:

```bash
node --test --test-concurrency=1 \
  tests/server-plugin-entry.test.js \
  tests/server-errors.test.js \
  tests/server-storage.test.js \
  tests/server-operations.test.js \
  tests/server-secrets.test.js \
  tests/server-destination-policy.test.js \
  tests/server-safe-fetch.test.js \
  tests/server-connections.test.js \
  tests/server-router.test.js
```

Обязательные доказательства:

- plugin shape совместим с SillyTavern;
- per-user storage изолирован;
- internal create/update/delete operations are crash-recoverable;
- public foundation API exposes status and safe list only; write routes wait for validated probe receipts in Gate C;
- secret никогда не попадает в safe projection;
- private/metadata destinations заблокированы.

### Gate B — OpenAI paid-request safety checkpoint

Этот checkpoint запускается после общих journal/artifact/generation tasks в плане 2. Он доказывает OpenAI contract и paid-request safety отдельно, но не утверждает, что порядок реализации пропускает уже созданные Gemini/OpenRouter adapter modules.

```bash
node --test --test-concurrency=1 \
  tests/server-openai-images.test.js \
  tests/server-journal.test.js \
  tests/server-artifacts.test.js \
  tests/server-generation.test.js \
  tests/server-request-routes.test.js
```

Обязательные доказательства:

- generations и edits используют точные OpenAI Images contracts;
- один `requestId` даёт максимум один paid submission;
- result переживает socket interruption;
- `dispatching` после crash не ресабмитится;
- provider URL сохраняется до download.

### Gate C — All three adapters and merged discovery

```bash
node --test --test-concurrency=1 \
  tests/server-openai-images.test.js \
  tests/server-gemini-native.test.js \
  tests/server-openrouter-images.test.js \
  tests/server-probe-coordinator.test.js \
  tests/server-generation.test.js
```

Обязательные доказательства:

- relay-like endpoint объединяет GPT и Gemini routes;
- duplicate model IDs не теряют API family;
- OpenRouter использует dedicated `/api/v1/images`;
- probes не вызывают paid endpoints.

### Gate D — Client vertical slice

```bash
node --test --test-concurrency=1 \
  tests/server-image-api.test.js \
  tests/connections-server-facade.test.js \
  tests/tab-api-server-connections.test.js \
  tests/server-stage2-recovery.test.js \
  tests/image-recovery.test.js \
  tests/pipeline-stage2-serialization.test.js
```

Обязательные доказательства:

- server key не читается browser code;
- proxy probe/provider registry не вызываются для server records;
- pending `serverRequest` появляется до `/generate`;
- startup делает только status lookup;
- Resume при `REQUEST_NOT_FOUND` требует явного действия пользователя;
- Agnes/Pollinations legacy path не изменился.

### Gate E — Migration and release

```bash
node --test --test-concurrency=1 \
  tests/server-connection-migration.test.js \
  tests/data-port.test.js \
  tests/final-verification.test.js \
  tests/server-security.test.js \
  tests/server-st-integration.test.js
```

Затем полный suite:

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

На финальном gate legacy profile tests должны быть отдельно актуализированы, и полный suite должен стать green.

## Parallelization policy

GLM subagents можно запускать параллельно только в отдельных worktrees и только для задач без общих файлов.

Разрешённые группы после foundation contracts:

```text
OpenAI adapter files
Gemini adapter files
OpenRouter adapter files
client server-image-api.js
pure security fixtures
```

Нельзя параллельно редактировать:

```text
src/connections.js
src/ui/tab-api.js
src/image-api.js
src/image-recovery.js
src/pipeline-stage2.js
src/data-port.js
server-plugin/src/router.js
server-plugin/src/services/generation.js
```

Даже при параллельной подготовке контролирующий агент cherry-pick/интегрирует по одному commit и после каждого запускает interaction tests.

## Mandatory review checklist per task

Spec reviewer должен проверить:

- нет browser fallback для трёх server families;
- нет paid retries/fallbacks;
- нет произвольного upstream URL из `/generate` body;
- server connection ID стабилен;
- server key не возвращается клиенту;
- references не режутся молча;
- Agnes/Pollinations не мигрированы случайно;
- не появился универсальный DSL/framework вне scope.

Quality reviewer должен проверить:

- файл имеет одну ответственность;
- user scope берётся только из `req.user.directories.root`;
- bounded inputs/outputs;
- secrets, prompts и reference bytes не логируются;
- state transitions явные и тестируются;
- ошибок swallowing нет в correctness-critical code;
- нет зависимостей от browser globals в server plugin;
- нет зависимостей от локального абсолютного пути SillyTavern в production source.

## Commit policy

Каждая task заканчивается отдельным commit. Не объединять:

- storage и adapters;
- journal и generation service;
- facade и migration;
- migration и browser-key cleanup;
- UI и browser-path retirement;
- feature code и cleanup старых baseline tests.

Контролирующий агент не должен коммитить автоматически, если пользователь не дал durable разрешение на commits для execution session.
