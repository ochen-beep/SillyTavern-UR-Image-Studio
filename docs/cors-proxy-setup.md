# CORS Proxy Setup

UR Image Studio sends provider requests from the browser. A JSON request to a
provider endpoint that does not allow browser CORS requires the SillyTavern CORS
proxy. Enable it with `enableCorsProxy: true` in `config.yaml`, or start
SillyTavern with `--corsProxy`.

Direct-CORS endpoints need no proxy configuration. URIS uses the saved route
transport and sends a paid generation only once; it never retries a paid request
through another transport after an uncertain result.

## Multipart Edits

SillyTavern's CORS proxy supports JSON bodies only. Multipart image-edit
requests (`multipart/form-data`) require direct CORS support from the provider
endpoint. Configure multipart edits against a CORS-enabled endpoint; proxy-only
transport cannot perform them.

## Shared Settings and API Keys

Use one browser as the supported writer for shared URIS settings. Concurrent
writes from multiple browsers are not conflict-resolved. Connection metadata and
gallery cards are shared through SillyTavern, but API keys remain in the local
storage of each browser and must be entered separately per browser.

Syncthing can back up or transfer a SillyTavern installation. It is not live
multi-browser or multi-SillyTavern conflict resolution for URIS settings.
