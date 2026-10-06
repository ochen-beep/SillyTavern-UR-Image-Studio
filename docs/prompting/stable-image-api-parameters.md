---
source: https://api.stability.ai/v2alpha/openapi
fetched: 2026-10-01
---

# Stable Image API — Parameters (Stability AI, REST v2beta)

> Extracted verbatim from the official StabilityAI REST API OpenAPI 3.0
> specification (version `v2beta`), which powers the API reference at
> https://platform.stability.ai/docs/api-reference .
> Spec snapshot: 2026-09-11 (latest archived copy of
> https://api.stability.ai/v2alpha/openapi), fetched 2026-10-01.
>
> Endpoints covered (text-to-image generation):
>
> - `POST /v2beta/stable-image/generate/ultra` — Stable Image Ultra
> - `POST /v2beta/stable-image/generate/core` — Stable Image Core
> - `POST /v2beta/stable-image/generate/sd3` — Stable Diffusion 3.5

---

## POST /v2beta/stable-image/generate/ultra — Stable Image Ultra

Our most advanced text to image generation service, Stable Image Ultra creates the highest quality images
with unprecedented prompt understanding. Ultra excels in typography, complex compositions, dynamic lighting,
vibrant hues, and overall cohesion and structure of an art piece. Made from the most advanced models,
including Stable Diffusion 3.5, Ultra offers the best of the Stable Diffusion ecosystem.

### How to use

Please invoke this endpoint with a `POST` request.

The headers of the request must include an API key in the `authorization` field. The body of the request must be
`multipart/form-data`.  The accept header should be set to one of the following:
- `image/*` to receive the image in the format specified by the `output_format` parameter.
- `application/json` to receive the image in the format specified by the `output_format` parameter, but encoded to base64 in a JSON response.

The only required parameter is the `prompt` field, which should contain the text prompt for the image generation.

### Output

The resolution of the generated image will be 1 megapixel. The default resolution is 1024x1024.

### Credits

The Ultra service uses 8 credits per successful result. You will not be charged for failed results.

### Parameters

Required: `prompt`. Content type: `multipart/form-data`.

#### `prompt`

- Type: string (1 – 10,000 characters)
- Required: yes
- Description: What you wish to see in the output image. A strong, descriptive prompt that clearly defines
  elements, colors, and subjects will lead to better results.
  
  To control the weight of a given word use the format `(word:weight)`,
  where `word` is the word you'd like to control the weight of and `weight`
  is a value between 0 and 1. For example: `The sky was a crisp (blue:0.3) and (green:0.8)`
  would convey a sky that was blue and green, but more green than blue.

#### `negative_prompt`

- Type: string (up to 10,000 characters)
- Description: A blurb of text describing what you **do not** wish to see in the output image.
  This is an advanced feature.

#### `aspect_ratio`

- Type: string
- Default: `1:1`
- Allowed values: `21:9`, `16:9`, `3:2`, `5:4`, `1:1`, `4:5`, `2:3`, `9:16`, `9:21`
- Description: Controls the aspect ratio of the generated image.

#### `seed`

- Type: number (0 – 4294967294)
- Default: `0`
- Description: A specific value that is used to guide the 'randomness' of the generation. (Omit this parameter or pass `0` to use a random seed.)

#### `style_preset`

- Type: string
- Allowed values: `enhance`, `anime`, `photographic`, `digital-art`, `comic-book`, `fantasy-art`, `line-art`, `analog-film`, `neon-punk`, `isometric`, `low-poly`, `origami`, `modeling-compound`, `cinematic`, `3d-model`, `pixel-art`, `tile-texture`
- Description: Guides the image model towards a particular style.

#### `output_format`

- Type: string
- Default: `png`
- Allowed values: `jpeg`, `png`, `webp`
- Description: Dictates the `content-type` of the generated image.

#### `image`

- Type: binary
- Description: The image to use as the starting point for the generation.
  
  > **Important:** The `strength` parameter is required when `image` is provided.
  
  Supported Formats:
  - jpeg
  - png
  - webp
  
  Validation Rules:
  - Width must be between 64 and 16,384 pixels
  - Height must be between 64 and 16,384 pixels
  - Total pixel count must be at least 4,096 pixels

#### `strength`

- Type: number (0 – 1)
- Description: Sometimes referred to as _denoising_, this parameter controls how much influence the
  `image` parameter has on the generated image.  A value of 0 would yield an image that
  is identical to the input.  A value of 1 would be as if you passed in no image at all.
  
  > **Important:** This parameter is required when `image` is provided.

---

## POST /v2beta/stable-image/generate/core — Stable Image Core

Our primary service for text-to-image generation, Stable Image Core represents the best quality achievable at high
speed. No prompt engineering is required! Try asking for a style, a scene, or a character, and see what you get.

### How to use

Please invoke this endpoint with a `POST` request.

The headers of the request must include an API key in the `authorization` field. The body of the request must be
`multipart/form-data`, and the `accept` header should be set to one of the following:
  - `image/*` to receive the image in the format specified by the `output_format` parameter.
  - `application/json` to receive the image encoded as base64 in a JSON response.

The body of the request should include:
- `prompt`

The body may optionally include:
- `aspect_ratio`
- `negative_prompt`
- `seed`
- `style_preset`
- `output_format`

### Output

The resolution of the generated image will be 1.5 megapixels.

### Credits

Flat rate of 3 credits per successful generation.  You will not be charged for failed generations.

### Parameters

Required: `prompt`. Content type: `multipart/form-data`.

#### `prompt`

- Type: string (1 – 10,000 characters)
- Required: yes
- Description: What you wish to see in the output image. A strong, descriptive prompt that clearly defines
  elements, colors, and subjects will lead to better results.
  
  To control the weight of a given word use the format `(word:weight)`,
  where `word` is the word you'd like to control the weight of and `weight`
  is a value between 0 and 1. For example: `The sky was a crisp (blue:0.3) and (green:0.8)`
  would convey a sky that was blue and green, but more green than blue.

#### `aspect_ratio`

- Type: string
- Default: `1:1`
- Allowed values: `21:9`, `16:9`, `3:2`, `5:4`, `1:1`, `4:5`, `2:3`, `9:16`, `9:21`
- Description: Controls the aspect ratio of the generated image.

#### `negative_prompt`

- Type: string (up to 10,000 characters)
- Description: A blurb of text describing what you **do not** wish to see in the output image.
  This is an advanced feature.

#### `seed`

- Type: number (0 – 4294967294)
- Default: `0`
- Description: A specific value that is used to guide the 'randomness' of the generation. (Omit this parameter or pass `0` to use a random seed.)

#### `style_preset`

- Type: string
- Allowed values: `enhance`, `anime`, `photographic`, `digital-art`, `comic-book`, `fantasy-art`, `line-art`, `analog-film`, `neon-punk`, `isometric`, `low-poly`, `origami`, `modeling-compound`, `cinematic`, `3d-model`, `pixel-art`, `tile-texture`
- Description: Guides the image model towards a particular style.

#### `output_format`

- Type: string
- Default: `png`
- Allowed values: `png`, `jpeg`, `webp`
- Description: Dictates the `content-type` of the generated image.

---

## POST /v2beta/stable-image/generate/sd3 — Stable Diffusion 3.5

Generate using Stable Diffusion 3.5 models, Stability AI latest base model:

- **Stable Diffusion 3.5 Large**: At 8 billion parameters, with superior quality and
  prompt adherence, this base model is the most powerful in the Stable Diffusion
  family. This model is ideal for professional use cases at 1 megapixel resolution.

- **Stable Diffusion 3.5 Large Turbo**: A distilled version of Stable Diffusion 3.5 Large.
  SD3.5 Large Turbo generates high-quality images with exceptional prompt adherence
  in just 4 steps, making it considerably faster than Stable Diffusion 3.5 Large.

- **Stable Diffusion 3.5 Medium**: With 2.5 billion parameters, the model delivers an
  optimal balance between prompt accuracy and image quality, making it an efficient
  choice for fast high-performance image generation.

- **Stable Diffusion 3.5 Flash**: A distilled version of Stable Diffusion 3.5 Medium.
  SD3.5 Flash generates high-quality images with a 4 step process instead of 40, making
  it faster than Stable Diffusion 3.5 Medium.

Read more about the model capabilities [here](https://stability.ai/news/introducing-stable-diffusion-3-5).

As of April 17, 2025, we have deprecated the Stable Diffusion 3.0 APIs and will be automatically
re-routing calls to Stable Diffusion 3.0 models to Stable Diffusion 3.5 APIs at no extra cost.

### How to use

Please invoke this endpoint with a `POST` request.

The headers of the request must include an API key in the `authorization` field. The body of the request must be
`multipart/form-data`.  The accept header should be set to one of the following:
- `image/*` to receive the image in the format specified by the `output_format` parameter.
- `application/json` to receive the image encoded as base64 in a JSON response.

#### **Generating with a prompt**

Commonly referred to as **text-to-image**, this mode generates an image from text alone. While the only required
parameter is the `prompt`, it also supports an `aspect_ratio` parameter which can be used to control the
aspect ratio of the generated image.

#### **Generating with a prompt *and* an image**

Commonly referred to as **image-to-image**, this mode also generates an image from text but uses an existing image as the
starting point. The required parameters are:
- `prompt` - text to generate the image from
- `image` - the image to use as the starting point for the generation
- `strength` - controls how much influence the `image` parameter has on the output image
- `mode` - must be set to `image-to-image`

> **Note:** maximum request size is 10MiB.

### Output

The resolution of the generated image will be 1MP. The default resolution is 1024x1024.

### Credits

- **SD 3.5 Large**: Flat rate of 6.5 credits per successful generation.
- **SD 3.5 Large Turbo**: Flat rate of 4 credits per successful generation.
- **SD 3.5 Medium**: Flat rate of 3.5 credits per successful generation.
- **SD 3.5 Flash**: Flat rate of 2.5 credits per successful generation.

As always, you will not be charged for failed generations.

### Parameters

Required: `prompt`. Content type: `multipart/form-data`.

#### `prompt`

- Type: string (1 – 10,000 characters)
- Required: yes
- Description: What you wish to see in the output image. A strong, descriptive prompt that clearly defines
  elements, colors, and subjects will lead to better results.

#### `negative_prompt`

- Type: string (up to 10,000 characters)
- Description: Keywords of what you **do not** wish to see in the output image.
  This is an advanced feature.

#### `cfg_scale`

- Type: number (1 – 10)
- Description: How strictly the diffusion process adheres to the prompt text (higher values keep your image closer to your prompt). The _Large_ and _Medium_ models use a default of `4`. The _Turbo_ and _Flash_ model uses a default of `1`.

#### `aspect_ratio`

- Type: string
- Default: `1:1`
- Allowed values: `21:9`, `16:9`, `3:2`, `5:4`, `1:1`, `4:5`, `2:3`, `9:16`, `9:21`
- Description: Controls the aspect ratio of the generated image. Defaults to 1:1.
  
  > **Important:** This parameter is only valid for **text-to-image** requests.

#### `model`

- Type: string
- Default: `sd3.5-large`
- Allowed values: `sd3.5-large`, `sd3.5-large-turbo`, `sd3.5-medium`
- Description: The model to use for generation.
  
  - `sd3.5-large` requires 6.5 credits per generation
  - `sd3.5-large-turbo` requires 4 credits per generation
  - `sd3.5-medium` requires 3.5 credits per generation
  - `sd3.5-flash` requires 2.5 credits per generation
  - As of the April 17, 2025, `sd3-large`, `sd3-large-turbo` and `sd3-medium`
    are re-routed to their `sd3.5-[model version]` equivalent, at the same price.

#### `mode`

- Type: string
- Default: `text-to-image`
- Allowed values: `text-to-image`, `image-to-image`
- Description: Controls whether this is a text-to-image or image-to-image generation, which affects which parameters are required:
  - **text-to-image** requires only the `prompt` parameter
  - **image-to-image** requires the `prompt`, `image`, and `strength` parameters

#### `image`

- Type: binary
- Description: The image to use as the starting point for the generation.
  
  Supported formats:
    - jpeg
    - png
    - webp
  
  Supported dimensions:
    - Every side must be at least 64 pixels
  
  > **Important:** This parameter is only valid for **image-to-image** requests.

#### `strength`

- Type: number (0 – 1)
- Description: Sometimes referred to as _denoising_, this parameter controls how much influence the
  `image` parameter has on the generated image.  A value of 0 would yield an image that
  is identical to the input.  A value of 1 would be as if you passed in no image at all.
  
  > **Important:** This parameter is only valid for **image-to-image** requests. For SD 3.5 Flash, the
   best results for image-to-image generation are achieved with a `strength` between .94 - .97.

#### `seed`

- Type: number (0 – 4294967294)
- Default: `0`
- Description: A specific value that is used to guide the 'randomness' of the generation. (Omit this parameter or pass `0` to use a random seed.)

#### `style_preset`

- Type: string
- Allowed values: `enhance`, `anime`, `photographic`, `digital-art`, `comic-book`, `fantasy-art`, `line-art`, `analog-film`, `neon-punk`, `isometric`, `low-poly`, `origami`, `modeling-compound`, `cinematic`, `3d-model`, `pixel-art`, `tile-texture`
- Description: Guides the image model towards a particular style.

#### `output_format`

- Type: string
- Default: `png`
- Allowed values: `png`, `jpeg`, `webp`
- Description: Dictates the `content-type` of the generated image.
