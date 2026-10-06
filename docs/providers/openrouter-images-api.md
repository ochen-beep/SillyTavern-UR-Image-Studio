---
source: https://openrouter.ai/docs/api/api-reference/images/generate-an-image.md
fetched: 2026-10-01
fetcher: mcp web-reader (openrouter.ai блокирует прямую загрузку: Cloudflare 403 для curl/PowerShell/WebFetch)
status: TRUNCATED — сервис чтения обрезал ответ на ~28k символов (проверено дважды, в форматах markdown и text)
note: >
  Отсутствующий хвост (после ImageGenTextChunkEvent.properties.text) содержит по странице:
  остаток схемы ImageGenTextChunkEvent, схемы ImageGenImageChunkEvent / ImageGenCompletedEvent /
  ImageGenStreamErrorEvent и общие схемы (ProviderOptions, ProviderSort, ProviderSortConfig,
  AnthropicCacheCreation, CostDetails, AnthropicUsageIteration, AnthropicSpeed, ProviderName).
  Для полного текста открой source-URL в браузере (в браузере Cloudflare не блокирует).
---

> ## Documentation Index
> Fetch the complete documentation index at: https://openrouter.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Generate an image

POST-операция генерации изображения. Страница содержит описание операции и встроенный фрагмент
OpenAPI-спецификации (`/openapi/openapi.yaml`, operation generateImage).

<!-- [CONTENTS OMITTED: запрос/ответ — HTTP request examples, параметры (prompt — required, model,
aspect_ratio, user, seed), x-speakeasy-result-type, responses 200 -> ImageGenResponse, а также
компонентные схемы Usage, CostDetails, TokenProps, TokenUsage, AnnotationUrl, Annotation,
CompletionTokensDetails, PromptTokensDetails, TokenTypeUsage, LoadProviderMetadata, ExtendedUsage] -->

Секция стриминга (последняя полученная часть, verbatim до точки обрыва):

ImageGenTextChunkEvent:
        type: object
        required:
          - type
          - phase
        properties:
          type:
            type: string
            enum:
              - text
          phase:
            type: string
            enum:
              - content
          text:
<!-- [TRUNCATED HERE BY FETCH SERVICE ~28k chars] -->
