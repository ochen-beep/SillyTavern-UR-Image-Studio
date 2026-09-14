export const geminiModelsFixture = {
  models: [
    {
      name: 'models/gemini-2.5-flash-image',
      displayName: 'Gemini 2.5 Flash Image',
      description: 'Native image generation model',
      version: '001',
      supportedGenerationMethods: ['generateContent'],
      inputTokenLimit: 32_768,
      outputTokenLimit: 8_192,
    },
    {
      name: 'models/gemini-3.1-flash-image-preview',
      displayName: 'Gemini 3.1 Flash Image Preview',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'publishers/example/models/gemini-image-custom',
      displayName: 'Custom path model',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-image-embedding',
      supportedGenerationMethods: ['embedContent'],
    },
  ],
};

export const openAiGeminiModelsFixture = {
  data: [
    { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google gemini' },
    { id: 'gemini-2.5-flash-image', object: 'model', owned_by: 'google gemini' },
    { id: 'gemini-3-pro-image', object: 'model', owned_by: 'google gemini' },
    { id: 'gemini-3.1-flash-image-preview', object: 'model', owned_by: 'google gemini' },
  ],
};

export const malformedGeminiModelsFixture = {
  models: { name: 'models/not-an-array' },
};
