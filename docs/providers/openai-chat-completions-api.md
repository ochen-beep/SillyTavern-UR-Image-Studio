---
source: https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
upstream_reference: https://platform.openai.com/docs/api-reference/chat
fetched: 2026-10-01
spec_version: "2.3.0 (OpenAPI 3.1.0, title: \"OpenAI API\")"
note: >
  platform.openai.com reference pages (/docs/api-reference/*) return 404 when rendered
  outside a browser, and the prose guide page could not be captured completely. This
  file therefore contains VERBATIM extracts from the official OpenAI OpenAPI
  specification (github.com/openai/openai-openapi, master branch, openapi.yaml v2.3.0)
  — the machine-readable source from which the platform Chat Completions API reference
  is generated. Nothing below is authored: all YAML blocks are copied as-is from the
  spec.
---

# OpenAI Chat Completions API reference (from official OpenAPI spec)

Endpoint covered: `POST /v1/chat/completions` (the endpoint this extension sends requests to and extracts image outputs from), plus its request/response schemas and the content-part types used for image inputs.

## /chat/completions path (list + create, verbatim)

```yaml
  /chat/completions:
    get:
      operationId: listChatCompletions
      tags:
        - Chat
      summary: List Chat Completions
      description: >
        List stored Chat Completions. Only Chat Completions that have been
        stored

        with the `store` parameter set to `true` will be returned.
      parameters:
        - name: model
          in: query
          description: The model used to generate the Chat Completions.
          required: false
          schema:
            type: string
        - name: metadata
          in: query
          description: |
            A list of metadata keys to filter the Chat Completions by. Example:

            `metadata[key1]=value1&metadata[key2]=value2`
          required: false
          schema:
            $ref: "#/components/schemas/Metadata"
        - name: after
          in: query
          description: Identifier for the last chat completion from the previous
            pagination request.
          required: false
          schema:
            type: string
        - name: limit
          in: query
          description: Number of Chat Completions to retrieve.
          required: false
          schema:
            type: integer
            default: 20
        - name: order
          in: query
          description: Sort order for Chat Completions by timestamp. Use `asc` for
            ascending order or `desc` for descending order. Defaults to `asc`.
          required: false
          schema:
            type: string
            enum:
              - asc
              - desc
            default: asc
      responses:
        "200":
          description: A list of Chat Completions
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ChatCompletionList"
        "400":
          description: Invalid pagination or filter parameters.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          $ref: "#/components/responses/TooManyRequests"
        "500":
          description: An internal error prevented the request from being completed.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
      x-oaiMeta:
        group: chat
        path: list
        examples:
          request:
            curl: |
              curl https://api.openai.com/v1/chat/completions \
                -H "Authorization: Bearer $OPENAI_API_KEY" \
                -H "Content-Type: application/json"
            python: |
              from openai import OpenAI
              client = OpenAI()

              completions = client.chat.completions.list()
              print(completions)
          response: >
            {
              "object": "list",
              "data": [
                {
                  "object": "chat.completion",
                  "id": "chatcmpl-AyPNinnUqUDYo9SAdA52NobMflmj2",
                  "model": "gpt-6-astra",
                  "created": 1738960610,
                  "request_id": "req_ded8ab984ec4bf840f37566c1011c417",
                  "tool_choice": null,
                  "usage": {
                    "total_tokens": 31,
                    "completion_tokens": 18,
                    "prompt_tokens": 13
                  },
                  "seed": 4944116822809979520,
                  "top_p": 1.0,
                  "temperature": 1.0,
                  "presence_penalty": 0.0,
                  "frequency_penalty": 0.0,
                  "system_fingerprint": "fp_50cad350e4",
                  "input_user": null,
                  "service_tier": "default",
                  "tools": null,
                  "metadata": {},
                  "choices": [
                    {
                      "index": 0,
                      "message": {
                        "content": "Mind of circuits hum,  \nLearning patterns in silence—  \nFuture's quiet spark.",
                        "role": "assistant",
                        "tool_calls": null,
                        "function_call": null
                      },
                      "finish_reason": "stop",
                      "logprobs": null
                    }
                  ],
                  "response_format": null
                }
              ],
              "first_id": "chatcmpl-AyPNinnUqUDYo9SAdA52NobMflmj2",
              "last_id": "chatcmpl-AyPNinnUqUDYo9SAdA52NobMflmj2",
              "has_more": false
            }
    post:
      operationId: createChatCompletion
      tags:
        - Chat
      summary: Create chat completion
      description: |
        **Starting a new project?** We recommend trying [Responses](https://developers.openai.com/api/reference/resources/responses)
        to take advantage of the latest OpenAI platform features. Compare
        [Chat Completions with Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses?api-mode=responses).

        ---

        Creates a model response for the given chat conversation. Learn more in the
        [text generation](https://developers.openai.com/api/docs/guides/text), [vision](https://developers.openai.com/api/docs/guides/images-vision),
        and [audio](https://developers.openai.com/api/docs/guides/audio) guides.

        Parameter support can differ depending on the model used to generate the
        response, particularly for newer reasoning models. Parameters that are only
        supported for reasoning models are noted below. For the current state of
        unsupported parameters in reasoning models,
        [refer to the reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

        Returns a chat completion object, or a streamed sequence of chat completion
        chunk objects if the request is streamed.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateChatCompletionRequest"
      responses:
        "200":
          description: >
            Returns a Chat Completion object for a non-streaming request.


            If `stream` is `true`, returns server-sent events
            (`text/event-stream`).

            Successful chunk frames contain a JSON Chat Completion chunk
            matching

            `CreateChatCompletionStreamResponse`. On normal completion, the
            final

            frame is:


            ```text

            data: [DONE]


            ```


            The final frame ends with a blank line. `[DONE]` is literal text,
            not a

            JSON chunk, and this frame has no `event: done` field.


            If a failure occurs after streaming has started, a data frame may

            contain a JSON object with an `error` field instead of a completion

            chunk. The streaming schema describes successful JSON chunks, not

            error frames or the completion marker. An interrupted stream may end

            without the marker.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CreateChatCompletionResponse"
            text/event-stream:
              schema:
                $ref: "#/components/schemas/CreateChatCompletionStreamResponse"
        "400":
          description: Invalid chat completion request or incompatible request parameters.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "401":
          description: Authentication failed because the API key is missing or revoked, or
            the client IP is not authorized.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
            text/plain:
              schema:
                type: string
                description: JSON-encoded error text containing an error object and the HTTP
                  status.
        "403":
          description: Access to a personal API organization is blocked by the
            organization policy.
          content:
            text/plain:
              schema:
                type: string
                description: JSON-encoded error text containing an error object and the HTTP
                  status.
        "404":
          description: The requested model or a referenced resource was not found or is
            unavailable to this caller.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          $ref: "#/components/responses/InferenceRateLimited"
        "500":
          description: The chat completion could not be processed due to an internal error.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          $ref: "#/components/responses/InferenceServiceUnavailable"
      x-oaiMeta:
        group: chat
        path: create
        examples:
          - title: Default
            request:
              curl: |
                curl https://api.openai.com/v1/chat/completions \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-6-astra",
                    "messages": [
                      {
                        "role": "developer",
                        "content": "You are a helpful assistant."
                      },
                      {
                        "role": "user",
                        "content": "Hello!"
                      }
                    ]
                  }'
              python: >
                from openai import OpenAI

                client = OpenAI()


                completion = client.chat.completions.create(
                  model="gpt-6-astra",
                  messages=[
                    {"role": "developer", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Hello!"}
                  ]
                )


                print(completion.choices[0].message)
              javascript: >
                import OpenAI from "openai";


                const openai = new OpenAI();


                async function main() {
                  const completion = await openai.chat.completions.create({
                    messages: [{ role: "developer", content: "You are a helpful assistant." }],
                    model: "gpt-6-astra",
                    store: true,
                  });

                  console.log(completion.choices[0]);
                }


                main();
              csharp: |
                using System;
                using System.Collections.Generic;

                using OpenAI.Chat;

                ChatClient client = new(
                    model: "gpt-6-astra",
                    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
                );

                List<ChatMessage> messages =
                [
                    new SystemChatMessage("You are a helpful assistant."),
                    new UserChatMessage("Hello!")
                ];

                ChatCompletion completion = client.CompleteChat(messages);

                Console.WriteLine(completion.Content[0].Text);
            response: |
              {
                "id": "chatcmpl-B9MBs8CjcvOU2jLn4n570S5qMJKcT",
                "object": "chat.completion",
                "created": 1741569952,
                "model": "gpt-6-astra",
                "choices": [
                  {
                    "index": 0,
                    "message": {
                      "role": "assistant",
                      "content": "Hello! How can I assist you today?",
                      "refusal": null,
                      "annotations": []
                    },
                    "logprobs": null,
                    "finish_reason": "stop"
                  }
                ],
                "usage": {
                  "prompt_tokens": 19,
                  "completion_tokens": 10,
                  "total_tokens": 29,
                  "prompt_tokens_details": {
                    "cached_tokens": 0,
                    "audio_tokens": 0
                  },
                  "completion_tokens_details": {
                    "reasoning_tokens": 0,
                    "audio_tokens": 0,
                    "accepted_prediction_tokens": 0,
                    "rejected_prediction_tokens": 0
                  }
                },
                "service_tier": "default"
              }
          - title: Image input
            request:
              curl: >
                curl https://api.openai.com/v1/chat/completions \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-6-astra",
                    "messages": [
                      {
                        "role": "user",
                        "content": [
                          {
                            "type": "text",
                            "text": "What is in this image?"
                          },
                          {
                            "type": "image_url",
                            "image_url": {
                              "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
                            }
                          }
                        ]
                      }
                    ],
                    "max_tokens": 300
                  }'
              python: >
                from openai import OpenAI


                client = OpenAI()


                response = client.chat.completions.create(
                    model="gpt-6-astra",
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "What's in this image?"},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg",
                                    }
                                },
                            ],
                        }
                    ],
                    max_tokens=300,
                )


                print(response.choices[0])
              javascript: >
                import OpenAI from "openai";


                const openai = new OpenAI();


                async function main() {
                  const response = await openai.chat.completions.create({
                    model: "gpt-6-astra",
                    messages: [
                      {
                        role: "user",
                        content: [
                          { type: "text", text: "What's in this image?" },
                          {
                            type: "image_url",
                            image_url: {
                              "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg",
                            },
                          }
                        ],
                      },
                    ],
                  });
                  console.log(response.choices[0]);
                }

                main();
              csharp: >
                using System;

                using System.Collections.Generic;


                using OpenAI.Chat;


                ChatClient client = new(
                    model: "gpt-6-astra",
                    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
                );


                List<ChatMessage> messages =

                [
                    new UserChatMessage(
                    [
                        ChatMessageContentPart.CreateTextPart("What's in this image?"),
                        ChatMessageContentPart.CreateImagePart(new Uri("https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"))
                    ])
                ];


                ChatCompletion completion = client.CompleteChat(messages);


                Console.WriteLine(completion.Content[0].Text);
            response: >
              {
                "id": "chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG",
                "object": "chat.completion",
                "created": 1741570283,
                "model": "gpt-6-astra",
                "choices": [
                  {
                    "index": 0,
                    "message": {
                      "role": "assistant",
                      "content": "The image shows a wooden boardwalk path running through a lush green field or meadow. The sky is bright blue with some scattered clouds, giving the scene a serene and peaceful atmosphere. Trees and shrubs are visible in the background.",
                      "refusal": null,
                      "annotations": []
                    },
                    "logprobs": null,
                    "finish_reason": "stop"
                  }
                ],
                "usage": {
                  "prompt_tokens": 1117,
                  "completion_tokens": 46,
                  "total_tokens": 1163,
                  "prompt_tokens_details": {
                    "cached_tokens": 0,
                    "audio_tokens": 0
                  },
                  "completion_tokens_details": {
                    "reasoning_tokens": 0,
                    "audio_tokens": 0,
                    "accepted_prediction_tokens": 0,
                    "rejected_prediction_tokens": 0
                  }
                },
                "service_tier": "default"
              }
          - title: Streaming
            request:
              curl: |
                curl https://api.openai.com/v1/chat/completions \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-6-astra",
                    "messages": [
                      {
                        "role": "developer",
                        "content": "You are a helpful assistant."
                      },
                      {
                        "role": "user",
                        "content": "Hello!"
                      }
                    ],
                    "stream": true
                  }'
              python: >
                from openai import OpenAI

                client = OpenAI()


                completion = client.chat.completions.create(
                  model="gpt-6-astra",
                  messages=[
                    {"role": "developer", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Hello!"}
                  ],
                  stream=True
                )


                for chunk in completion:
                  print(chunk.choices[0].delta)
              javascript: >
                import OpenAI from "openai";


                const openai = new OpenAI();


                async function main() {
                  const completion = await openai.chat.completions.create({
                    model: "gpt-6-astra",
                    messages: [
                      {"role": "developer", "content": "You are a helpful assistant."},
                      {"role": "user", "content": "Hello!"}
                    ],
                    stream: true,
                  });

                  for await (const chunk of completion) {
                    console.log(chunk.choices[0].delta.content);
                  }
                }


                main();
              csharp: >
                using System;

                using System.ClientModel;

                using System.Collections.Generic;

                using System.Threading.Tasks;


                using OpenAI.Chat;


                ChatClient client = new(
                    model: "gpt-6-astra",
                    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
                );


                List<ChatMessage> messages =

                [
                    new SystemChatMessage("You are a helpful assistant."),
                    new UserChatMessage("Hello!")
                ];


                AsyncCollectionResult<StreamingChatCompletionUpdate>
                completionUpdates = client.CompleteChatStreamingAsync(messages);


                await foreach (StreamingChatCompletionUpdate completionUpdate in
                completionUpdates)

                {
                    if (completionUpdate.ContentUpdate.Count > 0)
                    {
                        Console.Write(completionUpdate.ContentUpdate[0].Text);
                    }
                }
            response: |+
              data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-6-astra", "system_fingerprint": "fp_44709d6fcb", "choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

              data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-6-astra", "system_fingerprint": "fp_44709d6fcb", "choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}]}

              : Intermediate chat completion chunks omitted.

              data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-6-astra", "system_fingerprint": "fp_44709d6fcb", "choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}

              data: [DONE]

          - title: Functions
            request:
              curl: >
                curl https://api.openai.com/v1/chat/completions \

                -H "Content-Type: application/json" \

                -H "Authorization: Bearer $OPENAI_API_KEY" \

                -d '{
                  "model": "gpt-6-astra",
                  "messages": [
                    {
                      "role": "user",
                      "content": "What is the weather like in Boston today?"
                    }
                  ],
                  "tools": [
                    {
                      "type": "function",
                      "function": {
                        "name": "get_current_weather",
                        "description": "Get the current weather in a given location",
                        "parameters": {
                          "type": "object",
                          "properties": {
                            "location": {
                              "type": "string",
                              "description": "The city and state, e.g. San Francisco, CA"
                            },
                            "unit": {
                              "type": "string",
                              "enum": ["celsius", "fahrenheit"]
                            }
                          },
                          "required": ["location"]
                        }
                      }
                    }
                  ],
                  "tool_choice": "auto"
                }'
              python: >
                from openai import OpenAI

                client = OpenAI()


                tools = [
                  {
                    "type": "function",
                    "function": {
                      "name": "get_current_weather",
                      "description": "Get the current weather in a given location",
                      "parameters": {
                        "type": "object",
                        "properties": {
                          "location": {
                            "type": "string",
                            "description": "The city and state, e.g. San Francisco, CA",
                          },
                          "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                        },
                        "required": ["location"],
                      },
                    }
                  }
                ]

                messages = [{"role": "user", "content": "What's the weather like
                in Boston today?"}]

                completion = client.chat.completions.create(
                  model="gpt-6-astra",
                  messages=messages,
                  tools=tools,
                  tool_choice="auto"
                )


                print(completion)
              javascript: >
                import OpenAI from "openai";


                const openai = new OpenAI();


                async function main() {
                  const messages = [{"role": "user", "content": "What's the weather like in Boston today?"}];
                  const tools = [
                      {
                        "type": "function",
                        "function": {
                          "name": "get_current_weather",
                          "description": "Get the current weather in a given location",
                          "parameters": {
                            "type": "object",
                            "properties": {
                              "location": {
                                "type": "string",
                                "description": "The city and state, e.g. San Francisco, CA",
                              },
                              "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                            },
                            "required": ["location"],
                          },
                        }
                      }
                  ];

                  const response = await openai.chat.completions.create({
                    model: "gpt-6-astra",
                    messages: messages,
                    tools: tools,
                    tool_choice: "auto",
                  });

                  console.log(response);
                }


                main();
              csharp: >
                using System;

                using System.Collections.Generic;


                using OpenAI.Chat;


                ChatClient client = new(
                    model: "gpt-6-astra",
                    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
                );


                ChatTool getCurrentWeatherTool = ChatTool.CreateFunctionTool(
                    functionName: "get_current_weather",
                    functionDescription: "Get the current weather in a given location",
                    functionParameters: BinaryData.FromString("""
                        {
                            "type": "object",
                            "properties": {
                                "location": {
                                    "type": "string",
                                    "description": "The city and state, e.g. San Francisco, CA"
                                },
                                "unit": {
                                    "type": "string",
                                    "enum": [ "celsius", "fahrenheit" ]
                                }
                            },
                            "required": [ "location" ]
                        }
                    """)
                );


                List<ChatMessage> messages =

                [
                    new UserChatMessage("What's the weather like in Boston today?"),
                ];


                ChatCompletionOptions options = new()

                {
                    Tools =
                    {
                        getCurrentWeatherTool
                    },
                    ToolChoice = ChatToolChoice.CreateAutoChoice(),
                };


                ChatCompletion completion = client.CompleteChat(messages,
                options);
            response: |
              {
                "id": "chatcmpl-abc123",
                "object": "chat.completion",
                "created": 1699896916,
                "model": "gpt-6-astra",
                "choices": [
                  {
                    "index": 0,
                    "message": {
                      "role": "assistant",
                      "content": null,
                      "tool_calls": [
                        {
                          "id": "call_abc123",
                          "type": "function",
                          "function": {
                            "name": "get_current_weather",
                            "arguments": "{\n\"location\": \"Boston, MA\"\n}"
                          }
                        }
                      ]
                    },
                    "logprobs": null,
                    "finish_reason": "tool_calls"
                  }
                ],
                "usage": {
                  "prompt_tokens": 82,
                  "completion_tokens": 17,
                  "total_tokens": 99,
                  "completion_tokens_details": {
                    "reasoning_tokens": 0,
                    "accepted_prediction_tokens": 0,
                    "rejected_prediction_tokens": 0
                  }
                }
              }
          - title: Logprobs
            request:
              curl: |
                curl https://api.openai.com/v1/chat/completions \
                  -H "Content-Type: application/json" \
                  -H "Authorization: Bearer $OPENAI_API_KEY" \
                  -d '{
                    "model": "gpt-6-sol",
                    "messages": [
                      {
                        "role": "user",
                        "content": "Hello!"
                      }
                    ],
                    "reasoning_effort": "none",
                    "logprobs": true,
                    "top_logprobs": 2
                  }'
              python: |
                from openai import OpenAI
                client = OpenAI()

                completion = client.chat.completions.create(
                  model="gpt-6-sol",
                  messages=[
                    {"role": "user", "content": "Hello!"}
                  ],
                  reasoning_effort="none",
                  logprobs=True,
                  top_logprobs=2
                )

                print(completion.choices[0].message)
                print(completion.choices[0].logprobs)
              javascript: |
                import OpenAI from "openai";

                const openai = new OpenAI();

                async function main() {
                  const completion = await openai.chat.completions.create({
                    messages: [{ role: "user", content: "Hello!" }],
                    model: "gpt-6-sol",
                    reasoning_effort: "none",
                    logprobs: true,
                    top_logprobs: 2,
                  });

                  console.log(completion.choices[0]);
                }

                main();
              csharp: >
                using System;

                using System.Collections.Generic;


                using OpenAI.Chat;


                ChatClient client = new(
                    model: "gpt-6-sol",
                    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY")
                );


                List<ChatMessage> messages =

                [
                    new UserChatMessage("Hello!")
                ];


                ChatCompletionOptions options = new()

                {
                    ReasoningEffortLevel = ChatReasoningEffortLevel.None,
                    IncludeLogProbabilities = true,
                    TopLogProbabilityCount = 2
                };


                ChatCompletion completion = client.CompleteChat(messages,
                options);


                Console.WriteLine(completion.Content[0].Text);
            response: |
              {
                "id": "chatcmpl-123",
                "object": "chat.completion",
                "created": 1702685778,
                "model": "gpt-6-sol",
                "choices": [
                  {
                    "index": 0,
                    "message": {
                      "role": "assistant",
                      "content": "Hello! How can I assist you today?"
                    },
                    "logprobs": {
                      "content": [
                        {
                          "token": "Hello",
                          "logprob": -0.31725305,
                          "bytes": [72, 101, 108, 108, 111],
                          "top_logprobs": [
                            {
                              "token": "Hello",
                              "logprob": -0.31725305,
                              "bytes": [72, 101, 108, 108, 111]
                            },
                            {
                              "token": "Hi",
                              "logprob": -1.3190403,
                              "bytes": [72, 105]
                            }
                          ]
                        },
                        {
                          "token": "!",
                          "logprob": -0.02380986,
                          "bytes": [
                            33
                          ],
                          "top_logprobs": [
                            {
                              "token": "!",
                              "logprob": -0.02380986,
                              "bytes": [33]
                            },
                            {
                              "token": " there",
                              "logprob": -3.787621,
                              "bytes": [32, 116, 104, 101, 114, 101]
                            }
                          ]
                        },
                        {
                          "token": " How",
                          "logprob": -0.000054669687,
                          "bytes": [32, 72, 111, 119],
                          "top_logprobs": [
                            {
                              "token": " How",
                              "logprob": -0.000054669687,
                              "bytes": [32, 72, 111, 119]
                            },
                            {
                              "token": "<|end|>",
                              "logprob": -10.953937,
                              "bytes": null
                            }
                          ]
                        },
                        {
                          "token": " can",
                          "logprob": -0.015801601,
                          "bytes": [32, 99, 97, 110],
                          "top_logprobs": [
                            {
                              "token": " can",
                              "logprob": -0.015801601,
                              "bytes": [32, 99, 97, 110]
                            },
                            {
                              "token": " may",
                              "logprob": -4.161023,
                              "bytes": [32, 109, 97, 121]
                            }
                          ]
                        },
                        {
                          "token": " I",
                          "logprob": -3.7697225e-6,
                          "bytes": [
                            32,
                            73
                          ],
                          "top_logprobs": [
                            {
                              "token": " I",
                              "logprob": -3.7697225e-6,
                              "bytes": [32, 73]
                            },
                            {
                              "token": " assist",
                              "logprob": -13.596657,
                              "bytes": [32, 97, 115, 115, 105, 115, 116]
                            }
                          ]
                        },
                        {
                          "token": " assist",
                          "logprob": -0.04571125,
                          "bytes": [32, 97, 115, 115, 105, 115, 116],
                          "top_logprobs": [
                            {
                              "token": " assist",
                              "logprob": -0.04571125,
                              "bytes": [32, 97, 115, 115, 105, 115, 116]
                            },
                            {
                              "token": " help",
                              "logprob": -3.1089056,
                              "bytes": [32, 104, 101, 108, 112]
                            }
                          ]
                        },
                        {
                          "token": " you",
                          "logprob": -5.4385737e-6,
                          "bytes": [32, 121, 111, 117],
                          "top_logprobs": [
                            {
                              "token": " you",
                              "logprob": -5.4385737e-6,
                              "bytes": [32, 121, 111, 117]
                            },
                            {
                              "token": " today",
                              "logprob": -12.807695,
                              "bytes": [32, 116, 111, 100, 97, 121]
                            }
                          ]
                        },
                        {
                          "token": " today",
                          "logprob": -0.0040071653,
                          "bytes": [32, 116, 111, 100, 97, 121],
                          "top_logprobs": [
                            {
                              "token": " today",
                              "logprob": -0.0040071653,
                              "bytes": [32, 116, 111, 100, 97, 121]
                            },
                            {
                              "token": "?",
                              "logprob": -5.5247097,
                              "bytes": [63]
                            }
                          ]
                        },
                        {
                          "token": "?",
                          "logprob": -0.0008108172,
                          "bytes": [63],
                          "top_logprobs": [
                            {
                              "token": "?",
                              "logprob": -0.0008108172,
                              "bytes": [63]
                            },
                            {
                              "token": "?\n",
                              "logprob": -7.184561,
                              "bytes": [63, 10]
                            }
                          ]
                        }
                      ],
                      "refusal": null
                    },
                    "finish_reason": "stop"
                  }
                ],
                "usage": {
                  "prompt_tokens": 9,
                  "completion_tokens": 9,
                  "total_tokens": 18,
                  "completion_tokens_details": {
                    "reasoning_tokens": 0,
                    "accepted_prediction_tokens": 0,
                    "rejected_prediction_tokens": 0
                  }
                }
              }
```

## Schema: CreateChatCompletionRequest (verbatim — all request body parameters)

```yaml
    CreateChatCompletionRequest:
      allOf:
        - $ref: "#/components/schemas/CreateModelResponseProperties"
        - type: object
          properties:
            messages:
              description: |
                A list of messages comprising the conversation so far. Depending on the
                [model](https://developers.openai.com/api/docs/models) you use, different message types (modalities) are
                supported, like [text](https://developers.openai.com/api/docs/guides/text),
                [images](https://developers.openai.com/api/docs/guides/images-vision), and [audio](https://developers.openai.com/api/docs/guides/audio).
              type: array
              minItems: 1
              items:
                $ref: "#/components/schemas/ChatCompletionRequestMessage"
            model:
              description: >
                Model ID used to generate the response, like `gpt-6-astra` or
                `o3`. OpenAI

                offers a wide range of models with different capabilities,
                performance

                characteristics, and price points. Refer to the [model
                guide](https://developers.openai.com/api/docs/models)

                to browse and compare available models.
              $ref: "#/components/schemas/ModelIdsShared"
            service_tier:
              $ref: "#/components/schemas/ServiceTier"
            modalities:
              $ref: "#/components/schemas/ResponseModalities"
            verbosity:
              $ref: "#/components/schemas/Verbosity"
            reasoning_effort:
              $ref: "#/components/schemas/ReasoningEffort"
            max_completion_tokens:
              description: |
                An upper bound for the number of tokens that can be generated for a completion, including visible output tokens and [reasoning tokens](https://developers.openai.com/api/docs/guides/reasoning).
              type: integer
              nullable: true
            frequency_penalty:
              type: number
              default: 0
              minimum: -2
              maximum: 2
              nullable: true
              description: >
                Number between -2.0 and 2.0. Positive values penalize new tokens
                based on

                their existing frequency in the text so far, decreasing the
                model's

                likelihood to repeat the same line verbatim.
            presence_penalty:
              type: number
              default: 0
              minimum: -2
              maximum: 2
              nullable: true
              description: >
                Number between -2.0 and 2.0. Positive values penalize new tokens
                based on

                whether they appear in the text so far, increasing the model's
                likelihood

                to talk about new topics.
            web_search_options:
              type: object
              title: Web search
              description: |
                This tool searches the web for relevant results to use in a response.
                Learn more about the [web search tool](https://developers.openai.com/api/docs/guides/tools-web-search).
              properties:
                user_location:
                  type: object
                  nullable: true
                  required:
                    - type
                    - approximate
                  description: |
                    Approximate location parameters for the search.
                  properties:
                    type:
                      type: string
                      description: >
                        The type of location approximation. Always `approximate`.
                      enum:
                        - approximate
                      x-stainless-const: true
                    approximate:
                      $ref: "#/components/schemas/WebSearchLocation"
                search_context_size:
                  $ref: "#/components/schemas/WebSearchContextSize"
            top_logprobs:
              description: >
                An integer between 0 and 20 specifying the maximum number of
                most likely

                tokens to return at each token position, each with an associated
                log

                probability. In some cases, the number of returned tokens may be
                fewer than

                requested.

                `logprobs` must be set to `true` if this parameter is used.
              type: integer
              minimum: 0
              maximum: 20
              nullable: true
            response_format:
              description: |
                An object specifying the format that the model must output.

                Setting to `{ "type": "json_schema", "json_schema": {...} }` enables
                Structured Outputs which ensures the model will match your supplied JSON
                schema. Learn more in the [Structured Outputs
                guide](https://developers.openai.com/api/docs/guides/structured-outputs).

                Setting to `{ "type": "json_object" }` enables the older JSON mode, which
                ensures the message the model generates is valid JSON. Using `json_schema`
                is preferred for models that support it.
              oneOf:
                - $ref: "#/components/schemas/ResponseFormatText"
                - $ref: "#/components/schemas/ResponseFormatJsonSchema"
                - $ref: "#/components/schemas/ResponseFormatJsonObject"
              discriminator:
                propertyName: type
            audio:
              type: object
              nullable: true
              description: >
                Parameters for audio output. Required when audio output is
                requested with

                `modalities: ["audio"]`. [Learn
                more](https://developers.openai.com/api/docs/guides/audio).
              required:
                - voice
                - format
              properties:
                voice:
                  $ref: "#/components/schemas/VoiceIdsOrCustomVoice"
                  description: >
                    The voice the model uses to respond. Supported built-in
                    voices are

                    `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`,
                    `onyx`,

                    `sage`, `shimmer`, `marin`, and `cedar`. You may also
                    provide a

                    custom voice object with an `id`, for example `{ "id":
                    "voice_1234" }`.
                format:
                  type: string
                  enum:
                    - wav
                    - aac
                    - mp3
                    - flac
                    - opus
                    - pcm16
                  description: >
                    Specifies the output audio format. Must be one of `wav`,
                    `mp3`, `flac`,

                    `opus`, or `pcm16`.
            store:
              type: boolean
              default: false
              nullable: true
              description: |
                Whether or not to store the output of this chat completion request for
                use in our [model distillation](https://developers.openai.com/api/docs/guides/supervised-fine-tuning#distilling-from-a-larger-model) or
                [evals](https://developers.openai.com/api/docs/guides/evals) products.

                Supports text and image inputs. Note: image inputs over 8MB will be dropped.
            moderation:
              anyOf:
                - $ref: "#/components/schemas/ModerationParam"
                  description: >
                    Configuration for running moderation on the request input
                    and generated output.
                - type: "null"
            stream:
              description: |
                If set to true, the model response data will be streamed to the client
                as it is generated using [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
                See the [Streaming section below](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
                for more information, along with the [streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
                guide for more information on how to handle the streaming events.
              type: boolean
              nullable: true
              default: false
            stop:
              $ref: "#/components/schemas/StopConfiguration"
            logit_bias:
              type: object
              x-oaiTypeLabel: map
              default: null
              nullable: true
              additionalProperties:
                type: integer
              description: >
                Modify the likelihood of specified tokens appearing in the
                completion.


                Accepts a JSON object that maps tokens (specified by their token
                ID in the

                tokenizer) to an associated bias value from -100 to 100.
                Mathematically,

                the bias is added to the logits generated by the model prior to
                sampling.

                The exact effect will vary per model, but values between -1 and
                1 should

                decrease or increase likelihood of selection; values like -100
                or 100

                should result in a ban or exclusive selection of the relevant
                token.
            logprobs:
              description: >
                Whether to return log probabilities of the output tokens or not.
                If true,

                returns the log probabilities of each output token returned in
                the

                `content` of `message`.
              type: boolean
              default: false
              nullable: true
            max_tokens:
              description: |
                The maximum number of [tokens](https://platform.openai.com/tokenizer) that can be generated in the
                chat completion. This value can be used to control
                [costs](https://openai.com/api/pricing/) for text generated via API.

                This value is now deprecated in favor of `max_completion_tokens`, and is
                not compatible with [o-series models](https://developers.openai.com/api/docs/guides/reasoning).
              type: integer
              nullable: true
              deprecated: true
            n:
              type: integer
              minimum: 1
              maximum: 128
              default: 1
              example: 1
              nullable: true
              description: How many chat completion choices to generate for each input
                message. Note that you will be charged based on the number of
                generated tokens across all of the choices. Keep `n` as `1` to
                minimize costs.
            prediction:
              nullable: true
              description: |
                Configuration for a [Predicted Output](https://developers.openai.com/api/docs/guides/predicted-outputs),
                which can greatly improve response times when large parts of the model
                response are known ahead of time. This is most common when you are
                regenerating a file with only minor changes to most of the content.
              oneOf:
                - $ref: "#/components/schemas/PredictionContent"
            seed:
              type: integer
              format: int64
              minimum: -9223372036854775808
              maximum: 9223372036854775807
              nullable: true
              deprecated: true
              description: >
                This feature is in Beta.

                If specified, our system will make a best effort to sample
                deterministically, such that repeated requests with the same
                `seed` and parameters should return the same result.

                Determinism is not guaranteed, and you should refer to the
                `system_fingerprint` response parameter to monitor changes in
                the backend.
              x-oaiMeta:
                beta: true
            stream_options:
              $ref: "#/components/schemas/ChatCompletionStreamOptions"
            tools:
              type: array
              description: |
                A list of tools the model may call. You can provide either
                [custom tools](https://developers.openai.com/api/docs/guides/function-calling#custom-tools) or
                [function tools](https://developers.openai.com/api/docs/guides/function-calling).
              items:
                oneOf:
                  - $ref: "#/components/schemas/ChatCompletionTool"
                  - $ref: "#/components/schemas/CustomToolChatCompletions"
            tool_choice:
              $ref: "#/components/schemas/ChatCompletionToolChoiceOption"
            parallel_tool_calls:
              $ref: "#/components/schemas/ParallelToolCalls"
            function_call:
              deprecated: true
              description: >
                Deprecated in favor of `tool_choice`.


                Controls which (if any) function is called by the model.


                `none` means the model will not call a function and instead
                generates a

                message.


                `auto` means the model can pick between generating a message or
                calling a

                function.


                Specifying a particular function via `{"name": "my_function"}`
                forces the

                model to call that function.


                `none` is the default when no functions are present. `auto` is
                the default

                if functions are present.
              oneOf:
                - type: string
                  description: >
                    `none` means the model will not call a function and instead
                    generates a message. `auto` means the model can pick between
                    generating a message or calling a function.
                  enum:
                    - none
                    - auto
                - $ref: "#/components/schemas/ChatCompletionFunctionCallOption"
            functions:
              deprecated: true
              description: |
                Deprecated in favor of `tools`.

                A list of functions the model may generate JSON inputs for.
              type: array
              minItems: 1
              maxItems: 128
              items:
                $ref: "#/components/schemas/ChatCompletionFunctions"
          required:
            - model
            - messages
```

## Schema: CreateChatCompletionResponse (verbatim)

```yaml
    CreateChatCompletionResponse:
      type: object
      description: Represents a chat completion response returned by model, based on
        the provided input.
      properties:
        id:
          type: string
          description: A unique identifier for the chat completion.
        choices:
          type: array
          description: A list of chat completion choices. Can be more than one if `n` is
            greater than 1.
          items:
            type: object
            required:
              - finish_reason
              - index
              - message
              - logprobs
            properties:
              finish_reason:
                type: string
                description: >
                  The reason the model stopped generating tokens. This will be
                  `stop` if the model hit a natural stop point or a provided
                  stop sequence,

                  `length` if the maximum number of tokens specified in the
                  request was reached,

                  `content_filter` if content was omitted due to a flag from our
                  content filters,

                  `tool_calls` if the model called a tool, or `function_call`
                  (deprecated) if the model called a function.

                  Read the [Model
                  Spec](https://model-spec.openai.com/2025-12-18.html) for more.
                enum:
                  - stop
                  - length
                  - tool_calls
                  - content_filter
                  - function_call
              index:
                type: integer
                description: The index of the choice in the list of choices.
              message:
                $ref: "#/components/schemas/ChatCompletionResponseMessage"
              logprobs:
                anyOf:
                  - description: Log probability information for the choice.
                    type: object
                    properties:
                      content:
                        anyOf:
                          - description: A list of message content tokens with log probability information.
                            type: array
                            items:
                              $ref: "#/components/schemas/ChatCompletionTokenLogprob"
                          - type: "null"
                      refusal:
                        anyOf:
                          - description: A list of message refusal tokens with log probability information.
                            type: array
                            items:
                              $ref: "#/components/schemas/ChatCompletionTokenLogprob"
                          - type: "null"
                    required:
                      - content
                      - refusal
                  - type: "null"
        created:
          type: integer
          format: unixtime
          description: The Unix timestamp (in seconds) of when the chat completion was
            created.
        model:
          type: string
          description: The model used for the chat completion.
        metadata:
          $ref: "#/components/schemas/Metadata"
        service_tier:
          $ref: "#/components/schemas/ServiceTier"
        system_fingerprint:
          type: string
          deprecated: true
          description: >
            This fingerprint represents the backend configuration that the model
            runs with.


            Can be used in conjunction with the `seed` request parameter to
            understand when backend changes have been made that might impact
            determinism.
        object:
          type: string
          description: The object type, which is always `chat.completion`.
          enum:
            - chat.completion
          x-stainless-const: true
        usage:
          $ref: "#/components/schemas/CompletionUsage"
        moderation:
          anyOf:
            - $ref: "#/components/schemas/ChatCompletionModeration"
              description: >
                Moderation results for the request input and generated output,
                if moderated

                completions were requested.
            - type: "null"
      required:
        - choices
        - created
        - id
        - model
        - object
      x-oaiMeta:
        name: The chat completion object
        group: chat
        example: >
          {
            "id": "chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG",
            "object": "chat.completion",
            "created": 1741570283,
            "model": "gpt-6-astra",
            "choices": [
              {
                "index": 0,
                "message": {
                  "role": "assistant",
                  "content": "The image shows a wooden boardwalk path running through a lush green field or meadow. The sky is bright blue with some scattered clouds, giving the scene a serene and peaceful atmosphere. Trees and shrubs are visible in the background.",
                  "refusal": null,
                  "annotations": []
                },
                "logprobs": null,
                "finish_reason": "stop"
              }
            ],
            "usage": {
              "prompt_tokens": 1117,
              "completion_tokens": 46,
              "total_tokens": 1163,
              "prompt_tokens_details": {
                "cached_tokens": 0,
                "audio_tokens": 0
              },
              "completion_tokens_details": {
                "reasoning_tokens": 0,
                "audio_tokens": 0,
                "accepted_prediction_tokens": 0,
                "rejected_prediction_tokens": 0
              }
            },
            "service_tier": "default",
            "system_fingerprint": "fp_fc9f1d7035"
          }
```

## Schema: CreateChatCompletionStreamResponse (verbatim — streaming chunks)

```yaml
    CreateChatCompletionStreamResponse:
      type: object
      description: |
        Represents a streamed chunk of a chat completion response returned
        by the model, based on the provided input.
        [Learn more](https://developers.openai.com/api/docs/guides/streaming-responses).
      properties:
        id:
          type: string
          description: A unique identifier for the chat completion. Each chunk has the
            same ID.
        choices:
          type: array
          description: >
            A list of chat completion choices. Can contain more than one
            elements if `n` is greater than 1. Can also be empty for the

            last chunk if you set `stream_options: {"include_usage": true}`.
          items:
            type: object
            required:
              - delta
              - finish_reason
              - index
            properties:
              delta:
                $ref: "#/components/schemas/ChatCompletionStreamResponseDelta"
              logprobs:
                description: Log probability information for the choice.
                type:
                  - object
                  - "null"
                properties:
                  content:
                    description: A list of message content tokens with log probability information.
                    type:
                      - array
                      - "null"
                    items:
                      $ref: "#/components/schemas/ChatCompletionTokenLogprob"
                  refusal:
                    description: A list of message refusal tokens with log probability information.
                    type:
                      - array
                      - "null"
                    items:
                      $ref: "#/components/schemas/ChatCompletionTokenLogprob"
                required:
                  - content
                  - refusal
              finish_reason:
                type:
                  - string
                  - "null"
                description: >
                  The reason the model stopped generating tokens. This will be
                  `stop` if the model hit a natural stop point or a provided
                  stop sequence,

                  `length` if the maximum number of tokens specified in the
                  request was reached,

                  `content_filter` if content was omitted due to a flag from our
                  content filters,

                  `tool_calls` if the model called a tool, or `function_call`
                  (deprecated) if the model called a function.
                enum:
                  - stop
                  - length
                  - tool_calls
                  - content_filter
                  - function_call
                  - null
              index:
                type: integer
                description: The index of the choice in the list of choices.
        created:
          type: integer
          format: unixtime
          description: The Unix timestamp (in seconds) of when the chat completion was
            created. Each chunk has the same timestamp.
        model:
          type: string
          description: The model to generate the completion.
        obfuscation:
          type: string
          description: >
            An obfuscation string added to normalize the size of streamed chunks
            as a

            mitigation to certain side-channel attacks. The field is included by

            default and omitted when `stream_options.include_obfuscation` is
            `false`.
        service_tier:
          $ref: "#/components/schemas/ServiceTier"
        system_fingerprint:
          type: string
          deprecated: true
          description: >
            This fingerprint represents the backend configuration that the model
            runs with.

            Can be used in conjunction with the `seed` request parameter to
            understand when backend changes have been made that might impact
            determinism.
        object:
          type: string
          description: The object type, which is always `chat.completion.chunk`.
          enum:
            - chat.completion.chunk
          x-stainless-const: true
        usage:
          anyOf:
            - $ref: "#/components/schemas/CompletionUsage"
            - type: "null"
          description: >
            An optional field that will only be present when you set

            `stream_options: {"include_usage": true}` in your request. When
            present, it

            contains a null value **except for the last chunk** which contains
            the

            token usage statistics for the entire request.


            **NOTE:** If the stream is interrupted or cancelled, you may not

            receive the final usage chunk which contains the total token usage
            for

            the request.
        moderation:
          anyOf:
            - $ref: "#/components/schemas/ChatCompletionModeration"
              description: >
                Moderation results for the request input and generated output.
                Present

                on the moderation chunk when moderated completions are
                requested.
            - type: "null"
      required:
        - choices
        - created
        - id
        - model
        - object
      examples:
        - id: chatcmpl-123
          object: chat.completion.chunk
          created: 1694268190
          model: gpt-6-astra
          system_fingerprint: fp_44709d6fcb
          choices:
            - index: 0
              delta:
                content: Hello
              logprobs: null
              finish_reason: null
          obfuscation: p9K3xT6w
        - id: chatcmpl-123
          object: chat.completion.chunk
          created: 1694268190
          model: gpt-6-astra
          system_fingerprint: fp_44709d6fcb
          choices:
            - index: 0
              delta: {}
              logprobs: null
              finish_reason: stop
          obfuscation: ""
      x-oaiMeta:
        name: The chat completion chunk object
        group: chat
        example: |
          {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1694268190,"model":"gpt-6-astra", "system_fingerprint": "fp_44709d6fcb", "choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"obfuscation":"r4N7vQ2m"}
```

## Schema: ChatCompletionResponseMessage (verbatim — message object with content, tool_calls)

```yaml
    ChatCompletionResponseMessage:
      type: object
      description: A chat completion message generated by the model.
      properties:
        content:
          anyOf:
            - type: string
              description: The contents of the message.
            - type: "null"
        refusal:
          anyOf:
            - type: string
              description: The refusal message generated by the model.
            - type: "null"
        tool_calls:
          $ref: "#/components/schemas/ChatCompletionMessageToolCalls"
        annotations:
          type: array
          description: |
            Annotations for the message, when applicable, as when using the
            [web search tool](https://developers.openai.com/api/docs/guides/tools-web-search).
          items:
            type: object
            description: |
              A URL citation when using web search.
            required:
              - type
              - url_citation
            properties:
              type:
                type: string
                description: The type of the URL citation. Always `url_citation`.
                enum:
                  - url_citation
                x-stainless-const: true
              url_citation:
                type: object
                description: A URL citation when using web search.
                required:
                  - end_index
                  - start_index
                  - url
                  - title
                properties:
                  end_index:
                    type: integer
                    description: The index of the last character of the URL citation in the message.
                  start_index:
                    type: integer
                    description: The index of the first character of the URL citation in the
                      message.
                  url:
                    type: string
                    format: uri
                    description: The URL of the web resource.
                  title:
                    type: string
                    description: The title of the web resource.
        role:
          type: string
          enum:
            - assistant
          description: The role of the author of this message.
          x-stainless-const: true
        function_call:
          type: object
          deprecated: true
          description: Deprecated and replaced by `tool_calls`. The name and arguments of
            a function that should be called, as generated by the model.
          properties:
            arguments:
              type: string
              description: The arguments to call the function with, as generated by the model
                in JSON format. Note that the model does not always generate
                valid JSON, and may hallucinate parameters not defined by your
                function schema. Validate the arguments in your code before
                calling your function.
            name:
              type: string
              description: The name of the function to call.
          required:
            - name
            - arguments
        audio:
          anyOf:
            - type: object
              description: >
                If the audio output modality is requested, this object contains
                data

                about the audio response from the model. [Learn
                more](https://developers.openai.com/api/docs/guides/audio).
              required:
                - id
                - expires_at
                - data
                - transcript
              properties:
                id:
                  type: string
                  description: Unique identifier for this audio response.
                expires_at:
                  type: integer
                  format: unixtime
                  description: >
                    The Unix timestamp (in seconds) for when this audio response
                    will

                    no longer be accessible on the server for use in multi-turn

                    conversations.
                data:
                  type: string
                  description: >
                    Base64 encoded audio bytes generated by the model, in the
                    format

                    specified in the request.
                transcript:
                  type: string
                  description: Transcript of the audio generated by the model.
            - type: "null"
      required:
        - role
        - content
        - refusal
    ChatCompletionRole:
      type: string
      description: The role of the author of a message
      enum:
        - developer
        - system
        - user
        - assistant
        - tool
        - function
```

## Schema: ChatCompletionRequestMessageContentPartImage (verbatim)

```yaml
    ChatCompletionRequestMessageContentPartImage:
      type: object
      title: Image content part
      description: >
        Learn about [image
        inputs](https://developers.openai.com/api/docs/guides/images-vision).
      properties:
        type:
          type: string
          enum:
            - image_url
          description: The type of the content part.
          x-stainless-const: true
        image_url:
          type: object
          properties:
            url:
              type: string
              description: Either a URL of the image or the base64 encoded image data.
              format: uri
            detail:
              type: string
              description: Specifies the detail level of the image. Learn more in the [Vision
                guide](https://developers.openai.com/api/docs/guides/images-vision#choose-an-image-detail-level).
              enum:
                - auto
                - low
                - high
                - original
              default: auto
          required:
            - url
        prompt_cache_breakpoint:
          $ref: "#/components/schemas/PromptCacheBreakpointParam"
      required:
        - type
        - image_url
```

## Schema: ChatCompletionRequestMessageContentPartText (verbatim)

```yaml
    ChatCompletionRequestMessageContentPartText:
      type: object
      title: Text content part
      description: >
        Learn about [text
        inputs](https://developers.openai.com/api/docs/guides/text).
      properties:
        type:
          type: string
          enum:
            - text
          description: The type of the content part.
          x-stainless-const: true
        text:
          type: string
          description: The text content.
        prompt_cache_breakpoint:
          $ref: "#/components/schemas/PromptCacheBreakpointParam"
      required:
        - type
        - text
```

## Schema: ChatCompletionRequestMessageContentPartRefusal (verbatim)

```yaml
    ChatCompletionRequestMessageContentPartRefusal:
      type: object
      title: Refusal content part
      properties:
        type:
          type: string
          enum:
            - refusal
          description: The type of the content part.
          x-stainless-const: true
        refusal:
          type: string
          description: The refusal message generated by the model.
      required:
        - type
        - refusal
```

## Schema: ChatCompletionRequestUserMessageContentPart (verbatim)

```yaml
    ChatCompletionRequestUserMessageContentPart:
      oneOf:
        - $ref: "#/components/schemas/ChatCompletionRequestMessageContentPartText"
        - $ref: "#/components/schemas/ChatCompletionRequestMessageContentPartImage"
        - $ref: "#/components/schemas/ChatCompletionRequestMessageContentPartAudio"
        - $ref: "#/components/schemas/ChatCompletionRequestMessageContentPartFile"
```

## Schema: ChatCompletionMessageToolCall (verbatim)

```yaml
    ChatCompletionMessageToolCall:
      type: object
      title: Function tool call
      description: |
        A call to a function tool created by the model.
      properties:
        id:
          type: string
          description: The ID of the tool call.
        type:
          type: string
          enum:
            - function
          description: The type of the tool. Currently, only `function` is supported.
          x-stainless-const: true
        function:
          type: object
          description: The function that the model called.
          properties:
            name:
              type: string
              description: The name of the function to call.
            arguments:
              type: string
              description: The arguments to call the function with, as generated by the model
                in JSON format. Note that the model does not always generate
                valid JSON, and may hallucinate parameters not defined by your
                function schema. Validate the arguments in your code before
                calling your function.
          required:
            - name
            - arguments
      required:
        - id
        - type
        - function
```

---

*End of verbatim extract. Source file: openapi.yaml v2.3.0, github.com/openai/openai-openapi (MIT license).*
