---
source: https://platform.stability.ai/docs/features/multi-prompting
fetched: 2026-10-01
---

# Stable Diffusion Prompting — Official Stability AI Documentation

> Compiled from the official Stability AI Developer Platform documentation
> (platform.stability.ai). The site is a client-side single-page application,
> so the sections below were extracted **verbatim** from the official
> documentation content served at platform.stability.ai on 2026-10-01.
>
> Sections and their source pages:
>
> 1. Prompting with weights (multi-prompting and negative prompting) —
>    https://platform.stability.ai/docs/features/multi-prompting
> 2. Prompt-related generation parameters (prompt, dimensions, steps,
>    CFG scale, sampler, seed) —
>    https://platform.stability.ai/docs/features/api-parameters
> 3. SDXL prompting notes and official example prompts —
>    https://platform.stability.ai/docs/release-notes
>
> Relative links and image paths below (e.g. `/docs/...`, `/BasicPrompt.png`)
> resolve against https://platform.stability.ai .

---

## Part 1 — Multi-prompting (prompt weighting and negative prompting)

One of the core foundations of the API is the ability to generate images via prompting. With multi-prompting, you can mix concepts together by assigning each prompt a specific weight. Check out the examples below to learn how to execute multi-prompting calls via our API. With the ability to assign weights to individual prompts, developers can now negatively prompt Stable Diffusion, a popular strategy for generating more creative images by informing the model to avoid certain concepts.

Try it out live by clicking the link below to open the notebook in Google Colab!

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/drive/1q6EnvbxWpvnbucEvg3Bpu90jUkwx6nGn?usp=sharing)

### Python Example

#### 1. Install the Stability SDK package...

```bash
pip install stability-sdk
```

#### 2. Import our dependencies and set up our environment variables and API Key...

```python
import os
import io
import warnings
from PIL import Image
from stability_sdk import client
import stability_sdk.interfaces.gooseai.generation.generation_pb2 as generation

# Our Host URL should not be prepended with "https" nor should it have a trailing slash.
os.environ['STABILITY_HOST'] = 'grpc.stability.ai:443'

# Sign up for an account at the following link to get an API Key.
# https://platform.stability.ai/

# Click on the following link once you have created an account to be taken to your API Key.
# https://platform.stability.ai/account/keys

# Paste your API Key below.

os.environ['STABILITY_KEY'] = 'key-goes-here'
```

#### 3. Connect to the Stability API...

```python
# Set up our connection to the API.
stability_api = client.StabilityInference(
    key=os.environ['STABILITY_KEY'], # API Key reference.
    verbose=True, # Print debug messages.
    engine="stable-diffusion-xl-1024-v1-0", # Set the engine to use for generation.
    # Check out the following link for a list of available engines: https://platform.stability.ai/docs/features/api-parameters#engine
)
```

#### 4. Set up basic text-to-image parameters, save image on generation, and warning for if the safety filter is tripped...

```python
answers = stability_api.generate(
    prompt="beautiful night sky above japanese town, anime style",
    seed=1229080980, # If a seed is provided, the resulting generated image will be deterministic.
                     # What this means is that as long as all generation parameters remain the same, you can always recall the same image simply by generating it again.
                     # Note: This isn't quite the case for CLIP Guided generations, which we tackle in the CLIP Guidance documentation.
    steps=50, # Amount of inference steps performed on image generation. Defaults to 30.
    cfg_scale=8.0, # Influences how strongly your generation is guided to match your prompt.
                   # Setting this value higher increases the strength in which it tries to match your prompt.
                   # Defaults to 7.0 if not specified.
    width=1024, # Generation width, if not included defaults to 512 or 1024 depending on the engine.
    height=1024, # Generation height, if not included defaults to 512 or 1024 depending on the engine.
    samples=1, # Number of images to generate, defaults to 1 if not included.
    sampler=generation.SAMPLER_K_DPMPP_2M # Choose which sampler we want to denoise our generation with.
                                                 # Defaults to k_dpmpp_2m if not specified. Clip Guidance only supports ancestral samplers.
                                                 # (Available Samplers: ddim, plms, k_euler, k_euler_ancestral, k_heun, k_dpm_2, k_dpm_2_ancestral, k_dpmpp_2s_ancestral, k_lms, k_dpmpp_2m, k_dpmpp_sde)
)

# Set up our warning to print to the console if the adult content classifier is tripped.
# If adult content classifier is not tripped, save generated images.
for resp in answers:
    for artifact in resp.artifacts:
        if artifact.finish_reason == generation.FILTER:
            warnings.warn(
                "Your request activated the API's safety filters and could not be processed."
                "Please modify the prompt and try again.")
        if artifact.type == generation.ARTIFACT_IMAGE:
            img = Image.open(io.BytesIO(artifact.binary))
            img.save(str(artifact.seed)+ ".png") # Save our generated images with their seed number as the filename.
```

#### Resulting image written to `<seed>.png`:

![](/BasicPrompt.png)

#### 5. Set up multiprompt text-to-image parameters based on previous basic prompt for comparison...

```python
# Note: With multi-prompting, we can provide each prompt a specific weight. Negative weights are used to prompt the model to avoid certain concepts.
# Prompts with token lengths beyond 77 will be truncated. Default prompt weight is 1 if not specified.
answers = stability_api.generate(
    prompt= [generation.Prompt(text="beautiful night sky above japanese town, anime style",parameters=generation.PromptParameters(weight=1)),
    generation.Prompt(text="clouds",parameters=generation.PromptParameters(weight=-1))],
    # In the example above we are negative prompting clouds out of the initial concept.
    # When determining prompt weights, the total possible range is [-10, 10] but we recommend staying within the range of [-2, 2].
    seed=1229080980, # If a seed is provided, the resulting generated image will be deterministic.
                    # What this means is that as long as all generation parameters remain the same, you can always recall the same image simply by generating it again.
                    # Note: This is only true for non-CLIP Guided generations.
    steps=50, # Amount of inference steps performed on image generation. Defaults to 30.
    cfg_scale=8.0, # Influences how strongly your generation is guided to match your prompt.
                   # Setting this value higher increases the strength in which it tries to match your prompt.
                   # Defaults to 7.0 if not specified.
    width=1024, # Generation width, if not included defaults to 512 or 1024 depending on the engine.
    height=1024, # Generation height, if not included defaults to 512 or 1024 depending on the engine.
    samples=1, # Number of images to generate, defaults to 1 if not included.
    sampler=generation.SAMPLER_K_DPMPP_2M # Choose which sampler we want to denoise our generation with.
                                                 # Defaults to k_dpmpp_2m if not specified. Clip Guidance only supports ancestral samplers.
                                                 # (Available Samplers: ddim, plms, k_euler, k_euler_ancestral, k_heun, k_dpm_2, k_dpm_2_ancestral, k_dpmpp_2s_ancestral, k_lms, k_dpmpp_2m, k_dpmpp_sde)
)

# Set up our warning to print to the console if the adult content classifier is tripped.
# If adult content classifier is not tripped, save generated images.
for resp in answers:
    for artifact in resp.artifacts:
        if artifact.finish_reason == generation.FILTER:
            warnings.warn(
                "Your request activated the API's safety filters and could not be processed."
                "Please modify the prompt and try again.")
        if artifact.type == generation.ARTIFACT_IMAGE:
            img = Image.open(io.BytesIO(artifact.binary))
            img.save(str(artifact.seed)+ ".png") # Save our generated images with their seed number as the filename.
```

#### Resulting image written to `<seed>.png`:

![](/MultiPrompt.png)

**Note:** This is not representative of all of the parameters available for image generation.

Please check out our [protobuf reference](https://github.com/Stability-AI/api-interfaces/blob/main/src/proto/generation.proto) for a complete list of parameters available for image generation.

---

## Part 2 — Prompt-related generation parameters

Source: https://platform.stability.ai/docs/features/api-parameters

When calling the gRPC API, `prompt` is the only required variable. Provided alone, this call will generate an image according to our default generation settings.

These calls can be assigned a variety of parameters, some of which have an effect on pricing, as detailed below.

### Prompt

Accepts singular as well as multiple prompts with weights. See the [Multi-prompting](https://platform.stability.ai/docs/features/multi-prompting) documentation for more information.

| Parameter | Default | Affects Pricing? |
| --------- | ------- | ---------------- |
| prompt    | none    | No               |

### Height

Measured in pixels. Pixel limit is `1048576`, so technically any dimension is allowable within that amount.

| Parameter | Default | Typical | Allowable         | Affects Pricing? |
| --------- | ------- | ------- | ----------------- | ---------------- |
| height    | 512     | 512     | See Below         | Yes              |

### Width

Measured in pixels. Pixel limit is `1048576`, so technically any dimension is allowable within that amount.

| Parameter | Default | Typical | Allowable         | Affects Pricing? |
| --------- | ------- | ------- | ----------------- | ---------------- |
| width     | 512     | 512     | See Below         | Yes              |

### About Dimensions

A minimum of `262k` pixels and a maximum of `1.04m` pixels are recommended when generating images with `512px` models, and a minimum of `589k` pixels and a maximum of `1.04m` pixels for `768px` models. The true pixel limit is `1048576`.

To avoid the dreaded `6N IndexError` it is advised to use `64px` increments when choosing an aspect ratio. Popular ratio combinations for `512px` models include `1536 x 512` and `1536 x 384`, while `1536 x 640` and `1024 x 576` are recommended for `768px` models.

For `512px` models, the minimum useful sizes are `192-256` in one dimension. For `768px` models the minimum useful size is `384` in one dimension.

Generating images under the recommended dimensions may result in undesirable artifacts.

### Steps

Affects the number of diffusion steps performed on the requested generation.

| Parameter | Default | Typical | Allowable | Affects Pricing? |
| --------- | ------- | ------- | --------- | ---------------- |
| steps     | 30      | 30-50   | 10-150    | Yes              |

### CFG Scale

Dictates how closely the engine attempts to match a generation to the provided prompt. v2-x models respond well to lower CFG (IE: 4-8), where as v1-x models respond well to a higher range (IE: 7-14) and SDXL models respond well to a wider range (IE: 4-12).

| Parameter | Default | Typical | Allowable | Affects Pricing? |
| --------- | ------- | ------- | --------- | ---------------- |
| cfg_scale | 7.0     | 4-14    | 1-35      | No               |

### Sampler

Sampling engine to use. If no sampler is declared, an appropriate default sampler for the declared inference engine will be applied automatically.

Available samplers:

- ddim
- plms
- k_euler
- k_euler_ancestral
- k_heun
- k_dpm_2
- k_dpm_2_ancestral
- k_dpmpp_2s_ancestral
- k_dpmpp_2m
- k_dpmpp_sde

| Parameter | Default    | Typical    | Allowable      | Affects Pricing? |
| --------- | ---------- | ---------- | -------------- | ---------------- |
| sampler   | k_dpmpp_2m | k_dpmpp_2m | Check Comments | No               |

### Seed

Seed for random latent noise generation. Deterministic if not being used in concert with CLIP Guidance. If not specified, or set to `0`, then a random value will be used.

| Parameter | Default    | Allowable      | Affects Pricing? |
| --------- | ---------- | -------------- | ---------------- |
| seed      | 0 (random) | 0 - 2147483647 | No               |

**Note:** This is a living page and may not be representative of all of the parameters currently available for image generation.

Please check out our [protobuf reference](https://github.com/Stability-AI/api-interfaces/blob/main/src/proto/generation.proto) for a complete list of parameters available for image generation.

---

## Part 3 — SDXL prompting notes and official example prompts

Source: https://platform.stability.ai/docs/release-notes

### SDXL v1.0 Release

*July 26th, 2023*

Building upon the success of the **SDXL v0.9** release, **SDXL v1.0** brings with it a number of image detail improvements. Specifically, **SDXL v1.0** offers enhanced vibrancy and overall color tone accuracy, including deeper black and brighter white tones.

**Prompt:**`A wolf in Yosemite National Park, chilly nature documentary film photography`

**Negative Prompt:**`3d render, smooth, plastic, blurry, grainy, low-resolution, anime, deep-fried, oversaturated`

**Steps:**`50`

**Seed:**`992446758`

**CFG Scale:**`8`

`stable-diffusion-xl-1024-v1-0` supports a variety of aspect ratios. Please check the [API Parameters](https://platform.stability.ai/docs/features/api-parameters#about-dimensions) page for additional information.

### SDXL v0.9 Release

*June 27th, 2023*

**SDXL v0.9**, trained at a base resolution of `1024 x 1024`, produces massively improved image and composition detail over its predecessor.

**Prompt:**`A wolf in Yosemite National Park, chilly nature documentary film photography`

**Negative Prompt:**`3d render, smooth, plastic, blurry, grainy, low-resolution, anime, deep-fried, oversaturated`

**SDXL v0.9** has also been trained to handle multiple aspect ratios, a clear improvement over previous models that would often see repeated subjects / concepts in wide or tall aspect ratio generations.

**Dimensions (wide example):** `1344x768`

### SDXL Release (API support)

*Apr. 14th, 2023*

Here's a short summary of some of SDXL's capabilities, taken as an excerpt from [our blog post](https://stability.ai/blog/stable-diffusion-xl-beta-available-for-api-customers-and-dreamstudio-users) on SDXL's release:

- Next-level photorealism capabilities.

- Enhanced image composition and face generation.

- Rich visuals and jaw-dropping aesthetics.

- Use of shorter prompts to create descriptive imagery.

- Greater capability to produce legible text.
