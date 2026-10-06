---
source: https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
upstream_reference: https://platform.openai.com/docs/api-reference/images
fetched: 2026-10-01
spec_version: "2.3.0 (OpenAPI 3.1.0, title: \"OpenAI API\")"
note: >
  The page https://platform.openai.com/docs/api-reference/images could not be rendered
  (SPA; the renderer returned 404). This file instead contains VERBATIM extracts from
  the official OpenAI OpenAPI specification (github.com/openai/openai-openapi, master
  branch, openapi.yaml v2.3.0), which is the machine-readable source from which the
  platform API reference for the Images API is generated. Nothing below is authored:
  all YAML blocks are copied as-is from the spec.
---

# OpenAI Images API reference (from official OpenAPI spec)

Endpoints covered: `POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/images/variations`, plus their request/response schemas and streaming events.

## POST /images/generations (path definition, verbatim)

```yaml
  /images/generations:
    post:
      operationId: createImage
      tags:
        - Images
      summary: Create image
      description: >
        Creates an image given a prompt. [Learn
        more](https://developers.openai.com/api/docs/guides/images-vision).
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateImageRequest"
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ImagesResponse"
            text/event-stream:
              schema:
                $ref: "#/components/schemas/ImageGenStreamEvent"
        "400":
          description: Invalid image request, including invalid DALL-E parameters or input.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "403":
          description: The project does not have access to the requested model.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "410":
          description: The requested DALL-E image endpoint is unavailable because it has
            been retired.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          $ref: "#/components/responses/InferenceRateLimited"
        "500":
          description: The image could not be generated or processed.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          $ref: "#/components/responses/InferenceServiceUnavailable"
      x-oaiMeta:
        group: images
        examples:
          - title: Generate image
            request:
              curl: |
                curl https://api.openai.com/v1/images/generations \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-image-2.5-flare",
                    "prompt": "A cute baby sea otter",
                    "n": 1,
                    "size": "1024x1024"
                  }'
              python: |
                import base64
                from openai import OpenAI
                client = OpenAI()

                img = client.images.generate(
                    model="gpt-image-2.5-flare",
                    prompt="A cute baby sea otter",
                    n=1,
                    size="1024x1024"
                )

                image_bytes = base64.b64decode(img.data[0].b64_json)
                with open("output.png", "wb") as f:
                    f.write(image_bytes)
              javascript: |
                import OpenAI from "openai";
                import { writeFile } from "fs/promises";

                const client = new OpenAI();

                const img = await client.images.generate({
                  model: "gpt-image-2.5-flare",
                  prompt: "A cute baby sea otter",
                  n: 1,
                  size: "1024x1024"
                });

                const imageBuffer = Buffer.from(img.data[0].b64_json, "base64");
                await writeFile("output.png", imageBuffer);
            response: |
              {
                "created": 1713833628,
                "data": [
                  {
                    "b64_json": "..."
                  }
                ],
                "usage": {
                  "total_tokens": 100,
                  "input_tokens": 50,
                  "output_tokens": 50,
                  "input_tokens_details": {
                    "text_tokens": 10,
                    "image_tokens": 40
                  }
                }
              }
          - title: Streaming
            request:
              curl: |
                curl https://api.openai.com/v1/images/generations \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-image-2.5-flare",
                    "prompt": "A cute baby sea otter",
                    "n": 1,
                    "size": "1024x1024",
                    "stream": true
                  }' \
                  --no-buffer
              python: |
                from openai import OpenAI

                client = OpenAI()

                stream = client.images.generate(
                    model="gpt-image-2.5-flare",
                    prompt="A cute baby sea otter",
                    n=1,
                    size="1024x1024",
                    stream=True
                )

                for event in stream:
                    print(event)
              javascript: |
                import OpenAI from "openai";

                const client = new OpenAI();

                const stream = await client.images.generate({
                  model: "gpt-image-2.5-flare",
                  prompt: "A cute baby sea otter",
                  n: 1,
                  size: "1024x1024",
                  stream: true,
                });

                for await (const event of stream) {
                  console.log(event);
                }
            response: |
              event: image_generation.partial_image
              data: {"type":"image_generation.partial_image","b64_json":"...","partial_image_index":0}

              event: image_generation.completed
              data: {"type":"image_generation.completed","b64_json":"...","usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":40}}}
```

## POST /images/edits (path definition, verbatim)

```yaml
  /images/edits:
    post:
      operationId: createImageEdit
      tags:
        - Images
      summary: Create image edit
      description: Creates an edited or extended image given one or more source images
        and a prompt. This endpoint supports GPT Image models and `dall-e-2`.
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              $ref: "#/components/schemas/CreateImageEditRequest"
            examples:
              multipart_edit:
                summary: Multipart form upload (binary image + prompt)
                value:
                  model: gpt-image-1.5
                  prompt: Add a watercolor effect to this image
                  image: <binary image file>
                  size: 1024x1024
                  quality: high
          application/json:
            schema:
              $ref: "#/components/schemas/EditImageBodyJsonParam"
            examples:
              json_with_url:
                summary: JSON request with image URL
                value:
                  model: gpt-image-1.5
                  prompt: Add a watercolor effect to this image
                  images:
                    - image_url: https://example.com/source-image.png
                  size: 1024x1024
                  quality: high
              json_with_file_id:
                summary: JSON request with uploaded file id
                value:
                  model: gpt-image-1.5
                  prompt: Replace the background with a snowy mountain scene
                  images:
                    - file_id: file-abc123
                  mask:
                    file_id: file-mask123
                  output_format: png
                  output_compression: 100
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ImagesResponse"
            text/event-stream:
              schema:
                $ref: "#/components/schemas/ImageEditStreamEvent"
        "400":
          description: Invalid image request, including invalid DALL-E parameters or input.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "403":
          description: The project does not have access to the requested model.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "410":
          description: The requested DALL-E image endpoint is unavailable because it has
            been retired.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          $ref: "#/components/responses/InferenceRateLimited"
        "500":
          description: The image could not be generated or processed.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          $ref: "#/components/responses/InferenceServiceUnavailable"
      x-oaiMeta:
        group: images
        examples:
          - title: Edit image
            request:
              curl: >
                curl -s -D >(grep -i x-request-id >&2) \
                  -o >(jq -r '.data[0].b64_json' | base64 --decode > gift-basket.png) \
                  -X POST "https://api.openai.com/v1/images/edits" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -F "model=gpt-image-1.5" \
                  -F "image[]=@body-lotion.png" \
                  -F "image[]=@bath-bomb.png" \
                  -F "image[]=@incense-kit.png" \
                  -F "image[]=@soap.png" \
                  -F 'prompt=Create a lovely gift basket with these four items in it'
              python: >
                import base64

                from openai import OpenAI

                client = OpenAI()


                prompt = """

                Generate a photorealistic image of a gift basket on a white
                background

                labeled 'Relax & Unwind' with a ribbon and handwriting-like
                font,

                containing all the items in the reference pictures.

                """


                result = client.images.edit(
                    model="gpt-image-1.5",
                    image=[
                        open("body-lotion.png", "rb"),
                        open("bath-bomb.png", "rb"),
                        open("incense-kit.png", "rb"),
                        open("soap.png", "rb"),
                    ],
                    prompt=prompt
                )


                image_base64 = result.data[0].b64_json

                image_bytes = base64.b64decode(image_base64)


                # Save the image to a file

                with open("gift-basket.png", "wb") as f:
                    f.write(image_bytes)
              javascript: >
                import fs from "fs";

                import OpenAI, { toFile } from "openai";


                const client = new OpenAI();


                const imageFiles = [
                    "bath-bomb.png",
                    "body-lotion.png",
                    "incense-kit.png",
                    "soap.png",
                ];


                const images = await Promise.all(
                    imageFiles.map(async (file) =>
                        await toFile(fs.createReadStream(file), null, {
                            type: "image/png",
                        })
                    ),
                );


                const rsp = await client.images.edit({
                    model: "gpt-image-1.5",
                    image: images,
                    prompt: "Create a lovely gift basket with these four items in it",
                });


                // Save the image to a file

                const image_base64 = rsp.data[0].b64_json;

                const image_bytes = Buffer.from(image_base64, "base64");

                fs.writeFileSync("basket.png", image_bytes);
          - title: Streaming
            request:
              curl: >
                curl -s -N -X POST "https://api.openai.com/v1/images/edits" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -F "model=gpt-image-1.5" \
                  -F "image[]=@body-lotion.png" \
                  -F "image[]=@bath-bomb.png" \
                  -F "image[]=@incense-kit.png" \
                  -F "image[]=@soap.png" \
                  -F 'prompt=Create a lovely gift basket with these four items in it' \
                  -F "stream=true"
              python: >
                from openai import OpenAI


                client = OpenAI()


                prompt = """

                Generate a photorealistic image of a gift basket on a white
                background

                labeled 'Relax & Unwind' with a ribbon and handwriting-like
                font,

                containing all the items in the reference pictures.

                """


                stream = client.images.edit(
                    model="gpt-image-1.5",
                    image=[
                        open("body-lotion.png", "rb"),
                        open("bath-bomb.png", "rb"),
                        open("incense-kit.png", "rb"),
                        open("soap.png", "rb"),
                    ],
                    prompt=prompt,
                    stream=True
                )


                for event in stream:
                    print(event)
              javascript: >
                import fs from "fs";

                import OpenAI, { toFile } from "openai";


                const client = new OpenAI();


                const imageFiles = [
                    "bath-bomb.png",
                    "body-lotion.png",
                    "incense-kit.png",
                    "soap.png",
                ];


                const images = await Promise.all(
                    imageFiles.map(async (file) =>
                        await toFile(fs.createReadStream(file), null, {
                            type: "image/png",
                        })
                    ),
                );


                const stream = await client.images.edit({
                    model: "gpt-image-1.5",
                    image: images,
                    prompt: "Create a lovely gift basket with these four items in it",
                    stream: true,
                });


                for await (const event of stream) {
                    console.log(event);
                }
            response: |
              event: image_edit.partial_image
              data: {"type":"image_edit.partial_image","b64_json":"...","partial_image_index":0}

              event: image_edit.completed
              data: {"type":"image_edit.completed","b64_json":"...","usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":40}}}
```

## POST /images/variations (path definition, verbatim)

```yaml
  /images/variations:
    post:
      operationId: createImageVariation
      tags:
        - Images
      summary: Create image variation
      description: Creates a variation of a given image. This endpoint only supports
        `dall-e-2`.
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              $ref: "#/components/schemas/CreateImageVariationRequest"
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ImagesResponse"
        "400":
          description: Invalid image or request, or the request cannot be processed for
            this account.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "403":
          description: The project does not have access to the requested model.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "410":
          description: The image variations endpoint is no longer available.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          description: The image rate limit was exceeded.
          headers:
            X-RateLimit-Limit-Images:
              description: The image limit for the rate-limit window.
              schema:
                type: number
            X-RateLimit-Remaining-Images:
              description: The number of images remaining in the rate-limit window.
              schema:
                type: number
                minimum: 0
            X-RateLimit-Reset-Images:
              description: The number of seconds until the rate-limit window resets.
              schema:
                type: integer
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "500":
          description: The image variation could not be generated or processed.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
      x-oaiMeta:
        group: images
        examples:
          request:
            curl: |
              curl https://api.openai.com/v1/images/variations \
                -H "Authorization: Bearer $OPENAI_API_KEY" \
                -F image="@otter.png" \
                -F n=2 \
                -F size="1024x1024"
            python: |
              from openai import OpenAI
              client = OpenAI()

              response = client.images.create_variation(
                image=open("image_edit_original.png", "rb"),
                n=2,
                size="1024x1024"
              )
            javascript: |-
              import fs from "fs";
              import OpenAI from "openai";

              const openai = new OpenAI();

              async function main() {
                const image = await openai.images.createVariation({
                  image: fs.createReadStream("otter.png"),
                });

                console.log(image.data);
              }
              main();
            csharp: >
              using System;


              using OpenAI.Images;


              ImageClient client = new(
                  model: "dall-e-2",
                  apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
              );


              GeneratedImage image =
              client.GenerateImageVariation(imageFilePath: "otter.png");


              Console.WriteLine(image.ImageUri);
          response: |
            {
              "created": 1589478378,
              "data": [
                {
                  "url": "https://..."
                },
                {
                  "url": "https://..."
                }
              ]
            }
```

## Schema: CreateImageRequest (verbatim)

```yaml
    CreateImageRequest:
      type: object
      properties:
        prompt:
          description: A text description of the desired image(s). The maximum length is
            32000 characters for the GPT image models, 1000 characters for
            `dall-e-2` and 4000 characters for `dall-e-3`.
          type: string
          example: A cute baby sea otter
        model:
          anyOf:
            - type: string
            - type: string
              enum:
                - gpt-image-1.5
                - gpt-image-2
                - gpt-image-2-2026-04-21
                - gpt-image-2.5-sunburst
                - gpt-image-2.5-sunburst-2026-09-08
                - gpt-image-2.5-flare
                - gpt-image-2.5-flare-2026-09-08
                - dall-e-2
                - dall-e-3
                - gpt-image-1
                - gpt-image-1-mini
          x-oaiTypeLabel: string
          default: dall-e-2
          example: gpt-image-2.5-flare
          nullable: true
          description: The model to use for image generation. One of `dall-e-2`,
            `dall-e-3`, or a GPT image model (`gpt-image-1`, `gpt-image-1-mini`,
            `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2-2026-04-21`,
            `gpt-image-2.5-sunburst`, `gpt-image-2.5-sunburst-2026-09-08`,
            `gpt-image-2.5-flare`, `gpt-image-2.5-flare-2026-09-08`). Defaults
            to `dall-e-2` unless a parameter specific to the GPT image models is
            used.
        n:
          type: integer
          minimum: 1
          maximum: 10
          default: 1
          example: 1
          nullable: true
          description: The number of images to generate. Must be between 1 and 10. For
            `dall-e-3`, only `n=1` is supported.
        quality:
          type: string
          enum:
            - standard
            - hd
            - low
            - medium
            - high
            - xhigh
            - max
            - auto
          default: auto
          example: medium
          nullable: true
          description: >
            The quality of the image that will be generated.


            - `auto` (default value) will automatically select the best quality
            for the given
              model.
            - `high`, `medium` and `low` are supported for the GPT image models.

            - `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`, including
            their `2026-09-08`
              snapshots, also support `xhigh` and `max`.
            - `hd` and `standard` are supported for `dall-e-3`.

            - `standard` is the only option for `dall-e-2`.
        response_format:
          type: string
          enum:
            - url
            - b64_json
          default: url
          example: url
          nullable: true
          description: The format in which generated images with `dall-e-2` and `dall-e-3`
            are returned. Must be one of `url` or `b64_json`. URLs are only
            valid for 60 minutes after the image has been generated. This
            parameter isn't supported for the GPT image models, which always
            return base64-encoded images.
        output_format:
          type: string
          enum:
            - png
            - jpeg
            - webp
          default: png
          example: png
          nullable: true
          description: The format in which the generated images are returned. This
            parameter is only supported for the GPT image models. Must be one of
            `png`, `jpeg`, or `webp`.
        output_compression:
          type: integer
          default: 100
          example: 100
          nullable: true
          description: The compression level (0-100%) for the generated images. This
            parameter is only supported for the GPT image models with the `webp`
            or `jpeg` output formats, and defaults to 100.
        stream:
          type: boolean
          default: false
          example: false
          nullable: true
          description: |
            Generate the image in streaming mode. Defaults to `false`. See the
            [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation) for more information.
            This parameter is only supported for the GPT image models.
        partial_images:
          $ref: "#/components/schemas/PartialImages"
        size:
          anyOf:
            - type: string
            - type: string
              enum:
                - auto
                - 1024x1024
                - 1536x1024
                - 1024x1536
                - 256x256
                - 512x512
                - 1792x1024
                - 1024x1792
          default: auto
          example: 1024x1024
          nullable: true
          description: The size of the generated images. For `gpt-image-2`,
            `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`,
            `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, and
            `gpt-image-2.5-flare-2026-09-08`, arbitrary resolutions are
            supported as `WIDTHxHEIGHT` strings, for example `1536x864`. Width
            and height must both be divisible by 16 and the requested aspect
            ratio must be between 1:3 and 3:1. Resolutions above `2560x1440` are
            experimental, and the maximum supported resolution is `3840x2160`.
            The requested size must also satisfy the model's current pixel and
            edge limits. The standard sizes `1024x1024`, `1536x1024`, and
            `1024x1536` are supported by the GPT image models; `auto` is
            supported for models that allow automatic sizing. For `dall-e-2`,
            use one of `256x256`, `512x512`, or `1024x1024`. For `dall-e-3`, use
            one of `1024x1024`, `1792x1024`, or `1024x1792`.
        moderation:
          type: string
          enum:
            - low
            - auto
          default: auto
          example: low
          nullable: true
          description: Control the content-moderation level for images generated by the
            GPT image models. Must be either `low` for less restrictive
            filtering or `auto` (default value).
        background:
          type: string
          enum:
            - transparent
            - opaque
            - auto
          default: auto
          example: transparent
          nullable: true
          description: >
            Set the background of the generated image(s). This parameter is only
            supported for

            the GPT image models. Must be one of `transparent`, `opaque`, or
            `auto` (default

            value). When `auto` is used, the model will automatically determine
            the best

            background for the image.


            `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`, including their
            `2026-09-08`

            snapshots, support `opaque` and `transparent` backgrounds.
            Transparent backgrounds

            are available for supported GPT Image models. For `gpt-image-2` and

            `gpt-image-2-2026-04-21`, this support is in preview. When using
            `transparent`,

            set the output format to `png` or `webp`.
        style:
          type: string
          enum:
            - vivid
            - natural
          default: vivid
          example: vivid
          nullable: true
          description: The style of the generated images. This parameter is only supported
            for `dall-e-3`. Must be one of `vivid` or `natural`. Vivid causes
            the model to lean towards generating hyper-real and dramatic images.
            Natural causes the model to produce more natural, less hyper-real
            looking images.
        user:
          type: string
          example: user-1234
          description: |
            A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. [Learn more](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers).
      required:
        - prompt
```

## Schema: CreateImageEditRequest (verbatim)

```yaml
    CreateImageEditRequest:
      type: object
      properties:
        image:
          anyOf:
            - type: string
              format: binary
            - type: array
              maxItems: 16
              items:
                type: string
                format: binary
          description: >
            The image(s) to edit. Must be a supported image file or an array of
            images.


            For the GPT image models (`gpt-image-1`, `gpt-image-1-mini`,
            `gpt-image-1.5`,

            `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`,

            `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, and

            `gpt-image-2.5-flare-2026-09-08`), each image should be a `png`,
            `webp`, or `jpg`

            file less than 50MB. You can provide up to 16 images.
            `chatgpt-image-latest`

            follows the same input constraints as GPT image models.


            For `dall-e-2`, you can only provide one image, and it should be a
            square `png`

            file less than 4MB.
        prompt:
          description: A text description of the desired image(s). The maximum length is
            1000 characters for `dall-e-2`, and 32000 characters for the GPT
            image models.
          type: string
          example: A cute baby sea otter wearing a beret
        mask:
          description: An additional image whose fully transparent areas (e.g. where alpha
            is zero) indicate where `image` should be edited. If there are
            multiple images provided, the mask will be applied on the first
            image. Must be a valid PNG file, less than 4MB, and have the same
            dimensions as `image`.
          type: string
          format: binary
        background:
          type: string
          enum:
            - transparent
            - opaque
            - auto
          default: auto
          example: transparent
          nullable: true
          description: >
            Set the background of the generated image(s). This parameter is only
            supported for

            the GPT image models. Must be one of `transparent`, `opaque`, or
            `auto` (default

            value). When `auto` is used, the model will automatically determine
            the best

            background for the image.


            `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`, including their
            `2026-09-08`

            snapshots, support `opaque` and `transparent` backgrounds.
            Transparent backgrounds

            are available for supported GPT Image models. For `gpt-image-2` and

            `gpt-image-2-2026-04-21`, this support is in preview. When using
            `transparent`,

            set the output format to `png` or `webp`.
        model:
          anyOf:
            - type: string
            - type: string
              enum:
                - gpt-image-1.5
                - gpt-image-2
                - gpt-image-2-2026-04-21
                - gpt-image-2.5-sunburst
                - gpt-image-2.5-sunburst-2026-09-08
                - gpt-image-2.5-flare
                - gpt-image-2.5-flare-2026-09-08
                - dall-e-2
                - gpt-image-1
                - gpt-image-1-mini
                - chatgpt-image-latest
              x-stainless-const: true
          x-oaiTypeLabel: string
          default: gpt-image-1.5
          example: gpt-image-1.5
          nullable: true
          description: The model to use for image generation. One of `dall-e-2` or a GPT
            image model (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`,
            `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`,
            `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`,
            `gpt-image-2.5-flare-2026-09-08`, or `chatgpt-image-latest`).
            Defaults to `gpt-image-1.5`.
        n:
          type: integer
          minimum: 1
          maximum: 10
          default: 1
          example: 1
          nullable: true
          description: The number of images to generate. Must be between 1 and 10.
        size:
          anyOf:
            - type: string
            - type: string
              enum:
                - 256x256
                - 512x512
                - 1024x1024
                - 1536x1024
                - 1024x1536
                - auto
          default: 1024x1024
          example: 1024x1024
          nullable: true
          description: The size of the generated images. For `gpt-image-2`,
            `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`,
            `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, and
            `gpt-image-2.5-flare-2026-09-08`, arbitrary resolutions are
            supported as `WIDTHxHEIGHT` strings, for example `1536x864`. Width
            and height must both be divisible by 16 and the requested aspect
            ratio must be between 1:3 and 3:1. Resolutions above `2560x1440` are
            experimental, and the maximum supported resolution is `3840x2160`.
            The requested size must also satisfy the model's current pixel and
            edge limits. The standard sizes `1024x1024`, `1536x1024`, and
            `1024x1536` are supported by the GPT image models; `auto` is
            supported for models that allow automatic sizing. For `dall-e-2`,
            use one of `256x256`, `512x512`, or `1024x1024`. For `dall-e-3`, use
            one of `1024x1024`, `1792x1024`, or `1024x1792`.
        response_format:
          type: string
          enum:
            - url
            - b64_json
          example: url
          nullable: true
          description: The format in which the generated images are returned. Must be one
            of `url` or `b64_json`. URLs are only valid for 60 minutes after the
            image has been generated. This parameter is only supported for
            `dall-e-2` (default is `url` for `dall-e-2`), as GPT image models
            always return base64-encoded images.
        output_format:
          type: string
          enum:
            - png
            - jpeg
            - webp
          default: png
          example: png
          nullable: true
          description: >
            The format in which the generated images are returned. This
            parameter is

            only supported for the GPT image models. Must be one of `png`,
            `jpeg`, or `webp`.

            The default value is `png`.
        output_compression:
          type: integer
          default: 100
          example: 100
          nullable: true
          description: >
            The compression level (0-100%) for the generated images. This
            parameter

            is only supported for the GPT image models with the `webp` or `jpeg`
            output

            formats, and defaults to 100.
        user:
          type: string
          example: user-1234
          description: |
            A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. [Learn more](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers).
        input_fidelity:
          anyOf:
            - $ref: "#/components/schemas/InputFidelity"
            - type: "null"
        stream:
          type: boolean
          default: false
          example: false
          nullable: true
          description: |
            Edit the image in streaming mode. Defaults to `false`. See the
            [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation) for more information.
        partial_images:
          $ref: "#/components/schemas/PartialImages"
        quality:
          type: string
          enum:
            - standard
            - low
            - medium
            - high
            - xhigh
            - max
            - auto
          default: auto
          example: high
          nullable: true
          description: >
            The quality of the image that will be generated for GPT image
            models. The GPT image models support `low`, `medium`, and `high`.
            `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`, including their
            `2026-09-08` snapshots, also support `xhigh` and `max`. Defaults to
            `auto`.
      required:
        - prompt
        - image
```

## Schema: CreateImageVariationRequest (verbatim)

```yaml
    CreateImageVariationRequest:
      type: object
      properties:
        image:
          description: The image to use as the basis for the variation(s). Must be a valid
            PNG file, less than 4MB, and square.
          type: string
          format: binary
        model:
          anyOf:
            - type: string
            - type: string
              enum:
                - dall-e-2
              x-stainless-const: true
          x-oaiTypeLabel: string
          default: dall-e-2
          example: dall-e-2
          nullable: true
          description: The model to use for image generation. Only `dall-e-2` is supported
            at this time.
        n:
          type: integer
          minimum: 1
          maximum: 10
          default: 1
          example: 1
          nullable: true
          description: The number of images to generate. Must be between 1 and 10.
        response_format:
          type: string
          enum:
            - url
            - b64_json
          default: url
          example: url
          nullable: true
          description: The format in which the generated images are returned. Must be one
            of `url` or `b64_json`. URLs are only valid for 60 minutes after the
            image has been generated.
        size:
          type: string
          enum:
            - 256x256
            - 512x512
            - 1024x1024
          default: 1024x1024
          example: 1024x1024
          nullable: true
          description: The size of the generated images. Must be one of `256x256`,
            `512x512`, or `1024x1024`.
        user:
          type: string
          example: user-1234
          description: |
            A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. [Learn more](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers).
      required:
        - image
```

## Schema: Image (verbatim)

```yaml
    Image:
      type: object
      description: Represents the content or the URL of an image generated by the
        OpenAI API.
      properties:
        b64_json:
          type: string
          description: The base64-encoded JSON of the generated image. Returned by default
            for the GPT image models, and only present if `response_format` is
            set to `b64_json` for `dall-e-2` and `dall-e-3`.
        url:
          type: string
          format: uri
          description: When using `dall-e-2` or `dall-e-3`, the URL of the generated image
            if `response_format` is set to `url` (default value). Unsupported
            for the GPT image models.
        revised_prompt:
          type: string
          description: For `dall-e-3` only, the revised prompt that was used to generate
            the image.
```

## Schema: ImagesResponse (verbatim)

```yaml
    ImagesResponse:
      type: object
      title: Image generation response
      description: The response from the image generation endpoint.
      properties:
        created:
          type: integer
          format: unixtime
          description: The Unix timestamp (in seconds) of when the image was created.
        data:
          type: array
          description: The list of generated images.
          items:
            $ref: "#/components/schemas/Image"
        background:
          type: string
          description: The background parameter used for the image generation. Either
            `transparent` or `opaque`.
          enum:
            - transparent
            - opaque
        output_format:
          type: string
          description: The output format of the image generation. Either `png`, `webp`, or
            `jpeg`.
          enum:
            - png
            - webp
            - jpeg
        size:
          anyOf:
            - type: string
            - type: string
              enum:
                - 1024x1024
                - 1024x1536
                - 1536x1024
          description: The image dimensions as a `WIDTHxHEIGHT` string, for example
            `1536x864`.
        quality:
          type: string
          description: The quality of the image generated. One of `low`, `medium`, `high`,
            `xhigh`, or `max`.
          enum:
            - low
            - medium
            - high
            - xhigh
            - max
        usage:
          $ref: "#/components/schemas/ImageGenUsage"
      required:
        - created
      x-oaiMeta:
        name: The image generation response
        group: images
        example: |
          {
            "created": 1713833628,
            "data": [
              {
                "b64_json": "..."
              }
            ],
            "background": "transparent",
            "output_format": "png",
            "size": "1024x1024",
            "quality": "high",
            "usage": {
              "total_tokens": 100,
              "input_tokens": 50,
              "output_tokens": 50,
              "input_tokens_details": {
                "text_tokens": 10,
                "image_tokens": 40
              }
            }
          }
```

## Schema: ImagesUsage (verbatim)

```yaml
    ImagesUsage:
      type: object
      description: >
        For the GPT image models only, the token usage information for the image
        generation.
      required:
        - total_tokens
        - input_tokens
        - output_tokens
        - input_tokens_details
      properties:
        total_tokens:
          type: integer
          description: >
            The total number of tokens (images and text) used for the image
            generation.
        input_tokens:
          type: integer
          description: The number of tokens (images and text) in the input prompt.
        output_tokens:
          type: integer
          description: The number of image tokens in the output image.
        input_tokens_details:
          type: object
          description: The input tokens detailed information for the image generation.
          required:
            - text_tokens
            - image_tokens
          properties:
            text_tokens:
              type: integer
              description: The number of text tokens in the input prompt.
            image_tokens:
              type: integer
              description: The number of image tokens in the input prompt.
```

## Schema: ImageGenCompletedEvent (streaming, verbatim)

```yaml
    ImageGenCompletedEvent:
      type: object
      description: >
        Emitted when image generation has completed and the final image is
        available.
      properties:
        type:
          type: string
          description: |
            The type of the event. Always `image_generation.completed`.
          enum:
            - image_generation.completed
          x-stainless-const: true
        b64_json:
          type: string
          description: |
            Base64-encoded image data, suitable for rendering as an image.
        created_at:
          type: integer
          format: unixtime
          description: |
            The Unix timestamp when the event was created.
        size:
          anyOf:
            - type: string
            - type: string
              enum:
                - 1024x1024
                - 1024x1536
                - 1536x1024
                - auto
          description: The image dimensions as a `WIDTHxHEIGHT` string, for example
            `1536x864`.
        quality:
          type: string
          description: |
            The quality setting for the generated image.
          enum:
            - low
            - medium
            - high
            - xhigh
            - max
            - auto
        background:
          type: string
          description: |
            The background setting for the generated image.
          enum:
            - transparent
            - opaque
            - auto
        output_format:
          type: string
          description: |
            The output format for the generated image.
          enum:
            - png
            - webp
            - jpeg
        usage:
          $ref: "#/components/schemas/ImagesUsage"
      required:
        - type
        - b64_json
        - created_at
        - size
        - quality
        - background
        - output_format
        - usage
      x-oaiMeta:
        name: image_generation.completed
        group: images
        example: |
          {
            "type": "image_generation.completed",
            "b64_json": "...",
            "created_at": 1620000000,
            "size": "1024x1024",
            "quality": "high",
            "background": "transparent",
            "output_format": "png",
            "usage": {
              "total_tokens": 100,
              "input_tokens": 50,
              "output_tokens": 50,
              "input_tokens_details": {
                "text_tokens": 10,
                "image_tokens": 40
              }
            }
          }
```

## Schema: ImageGenPartialImageEvent (streaming, verbatim)

```yaml
    ImageGenPartialImageEvent:
      type: object
      description: >
        Emitted when a partial image is available during image generation
        streaming.
      properties:
        type:
          type: string
          description: |
            The type of the event. Always `image_generation.partial_image`.
          enum:
            - image_generation.partial_image
          x-stainless-const: true
        b64_json:
          type: string
          description: >
            Base64-encoded partial image data, suitable for rendering as an
            image.
        created_at:
          type: integer
          format: unixtime
          description: |
            The Unix timestamp when the event was created.
        size:
          anyOf:
            - type: string
            - type: string
              enum:
                - 1024x1024
                - 1024x1536
                - 1536x1024
                - auto
          description: The image dimensions as a `WIDTHxHEIGHT` string, for example
            `1536x864`.
        quality:
          type: string
          description: |
            The quality setting for the requested image.
          enum:
            - low
            - medium
            - high
            - xhigh
            - max
            - auto
        background:
          type: string
          description: |
            The background setting for the requested image.
          enum:
            - transparent
            - opaque
            - auto
        output_format:
          type: string
          description: |
            The output format for the requested image.
          enum:
            - png
            - webp
            - jpeg
        partial_image_index:
          type: integer
          description: |
            0-based index for the partial image (streaming).
      required:
        - type
        - b64_json
        - created_at
        - size
        - quality
        - background
        - output_format
        - partial_image_index
      x-oaiMeta:
        name: image_generation.partial_image
        group: images
        example: |
          {
            "type": "image_generation.partial_image",
            "b64_json": "...",
            "created_at": 1620000000,
            "size": "1024x1024",
            "quality": "high",
            "background": "transparent",
            "output_format": "png",
            "partial_image_index": 0
          }
```

## Schema: ImageGenStreamEvent (streaming, verbatim)

```yaml
    ImageGenStreamEvent:
      anyOf:
        - $ref: "#/components/schemas/ImageGenPartialImageEvent"
        - $ref: "#/components/schemas/ImageGenCompletedEvent"
      discriminator:
        propertyName: type
```

---

*End of verbatim extract. Source file: openapi.yaml v2.3.0, github.com/openai/openai-openapi (MIT license).*
