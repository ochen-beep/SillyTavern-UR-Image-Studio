---
source: https://openrouter.ai/docs/api/api-reference/images/list-endpoints-for-an-image-model.md
fetched: 2026-10-01
fetcher: mcp web-reader (openrouter.ai блокирует прямую загрузку: Cloudflare 403 для curl/PowerShell/WebFetch)
status: fetched-complete-by-reader; перенос в файл частичный — места пропусков помечены маркерами
---

> ## Documentation Index
> Fetch the complete documentation index at: https://openrouter.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# List endpoints for an image model

GET-операция списка эндпоинтов для модели генерации изображений. Страница содержит встроенный
фрагмент OpenAPI-спецификации (`/openapi/openapi.yaml`, operation listImageModelEndpoints).

Среди полученных компонентных схем (фрагментами): Usage, CostDetails, TokenProps, TokenUsage,
AnnotationUrl, Annotation, CompletionTokensDetails, PromptTokensDetails, TokenTypeUsage,
LoadProviderMetadata, ExtendedUsage; параметры эндпоинтов включают pricing (пример значения
"2K"), seed: boolean и др.

<!-- [CONTENTS OMITTED: средняя часть ответа сервиса чтения не перенесена в файл — открой source-URL в браузере для полного текста] -->

Фактическое окончание полученного документа (verbatim tail):

      summary: List endpoints for an image model
      x-speakeasy-operation-id: listImageModelEndpoints
```
