export const openAIModelsFixture = {
  object: 'list',
  data: [
    {
      id: 'gpt-image-1',
      object: 'model',
      owned_by: 'openai',
      capabilities: {
        image_generation: true,
        image_edit: true,
        max_input_images: 4,
      },
    },
    {
      id: 'dall-e-3',
      object: 'model',
      owned_by: 'openai',
    },
    {
      id: 'text-model-with-image-in-its-name',
      object: 'model',
      owned_by: 'example',
    },
    {
      id: 'gpt-4.1',
      object: 'model',
      owned_by: 'openai',
      capabilities: { image_generation: false },
    },
  ],
};

export const malformedOpenAIModelsFixture = {
  object: 'list',
  data: { id: 'not-an-array' },
};
