---
source: https://ai.google.dev/gemini-api/docs/imagen
fetched: 2026-10-01
---

# Generate images using Imagen

Imagen is Google's legacy image generation model. It is now shut down
and no longer available in the Gemini API.

## Migrate to Nano Banana

Migrate to Nano Banana for image generation:

- **Model name**: Use `gemini-2.5-flash-image` (or Nano Banana 2 models such as `gemini-3.1-flash-image`) instead of Imagen model names.
- **Method**: Use `client.models.generate_content` instead of
  `client.models.generate_images`.
- **Response handling**: Nano Banana returns content parts containing image data
  instead of a specific image response object.

See the [Image generation guide](https://ai.google.dev/gemini-api/docs/image-generation) for
details and examples.

---

Except as otherwise noted, the content of this page is licensed under the Creative Commons Attribution 4.0 License, and code samples are licensed under the Apache 2.0 License. For details, see the Google Developers Site Policies. Java is a registered trademark of Oracle and/or its affiliates.

Last updated 2026-09-17 UTC.
