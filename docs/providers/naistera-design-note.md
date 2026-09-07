# Naistera Design Note

Status: implemented — see `naistera-contract.md` for the live contract. This file is retained as the original design rationale.

The integration uses a provider base endpoint with:

- `GET /api/models` for an authenticated/custom catalog;
- `POST /api/generate` to create an operation;
- `GET /api/generate/jobs/{job_id}` to poll the operation;
- Bearer authentication.

The implemented adapter uses the verified request fields (`prompt`, `model`, `aspect_ratio`, optional `preset`/`reference_objects`, and `sync: false`), accepts synchronous image responses, or creates once and polls with a global deadline. It never issues a second create POST automatically.

The first Naistera scope is image-only. Video remains out of scope until URIS has an explicit video result, storage, and gallery contract; video models are filtered from the image catalog and video results are rejected before Gallery materialization. Per-model reference support is taken from the authenticated catalog and unknown support is rejected before a paid POST.
