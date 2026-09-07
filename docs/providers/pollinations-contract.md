# Pollinations Image Contract

Status: implemented synchronous image-generation adapter; this note is metadata-only and does not perform provider requests.

## Sources

- Base/API documentation: https://gen.pollinations.ai/docs
- LLM contract summary: https://gen.pollinations.ai/docs/llm.txt
- OpenAPI description: https://gen.pollinations.ai/openapi.json

## URIS contract

- Base endpoint: `https://gen.pollinations.ai`
- Catalog: `GET /image/models`; response is a public top-level array.
- Generation: `POST /v1/images/generations`.
- Authentication: `Authorization: Bearer sk_...`. URIS intentionally accepts only scoped `sk_` tokens. It does not use `pk_` as a generation credential, query-token authentication, or the legacy `image.pollinations.ai/<prompt>` GET path.
- The current adapter sends JSON with `model`, `prompt`, and `n: 1`. Aspect-ratio presets become `size=WIDTHxHEIGHT`.
- `resolution` is sent only when the model advertises it and is normalized to the provider wire spelling (`1k`, `2k`, `480p`, `720p`, `768p`, `1080p`).
- `quality` is sent only for the documented values `standard`, `hd`, `low`, `medium`, and `high` and only when the route advertises support.
- `safe` is sent only when explicitly provided and advertised by route metadata.
- `response_format` is omitted unless a future descriptor explicitly declares it; the provider default is used.

## Results and references

The adapter reads `data[0].b64_json`. It also accepts `data[0].url` as a compatibility result and sends it through the existing URIS materialization/gallery path. Public catalog access is not generation-token validation and never performs a paid generation probe.

References are rejected before the paid POST in this stage. `/v1/images/edits` is documented as a future conditional operation, but no edit adapter is exposed until model-specific input support is verified.

HTTP 401/403 become structured auth errors and no paid POST is automatically retried after an HTTP response, timeout, or ambiguous network outcome.

## Data boundaries

Tokens remain in the existing connection-scoped browser key store. Connection metadata, catalog records, event journal, diagnostics, backups, and netdumps contain only bounded metadata and redacted credentials. No generation, upload, account registration, or payment request is performed by fixtures or documentation.
