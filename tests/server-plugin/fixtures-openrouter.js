export const openRouterImageModelsFixture = {
  data: [
    {
      id: 'black-forest-labs/flux-1.1-pro',
      name: 'FLUX 1.1 Pro',
      description: 'Image generation model',
      capabilities: [
        { name: 'aspect_ratio', type: 'enum', values: ['1:1', '16:9'] },
        { name: 'resolution', type: 'enum', values: ['1K', '2K'] },
        { name: 'quality', type: 'enum', values: ['standard'] },
        { name: 'input_references', type: 'boolean', value: false },
      ],
    },
    {
      id: 'google/imagen-4-fast',
      name: 'Imagen 4 Fast',
      capabilities: [
        { name: 'aspect_ratio', type: 'enum', values: ['1:1'] },
      ],
    },
  ],
};

export const openRouterFluxEndpointsFixture = {
  data: {
    id: 'black-forest-labs/flux-1.1-pro',
    endpoints: [
      {
        provider_name: 'FAL',
        provider_slug: 'fal',
        provider_tag: 'fal',
        capabilities: [
          { name: 'aspect_ratio', type: 'enum', values: ['1:1', '3:2', '16:9'] },
          { name: 'resolution', type: 'enum', values: ['1K', '2K', '4K'] },
          { name: 'quality', type: 'enum', values: ['standard', 'high'] },
          { name: 'input_references', type: 'boolean', value: true },
          { name: 'max_input_references', type: 'range', min: 1, max: 4 },
        ],
      },
      {
        provider_name: 'Together',
        provider_slug: 'together',
        provider_tag: 'together',
        capabilities: [
          { name: 'aspect_ratio', type: 'enum', values: ['1:1'] },
          { name: 'resolution', type: 'enum', values: ['1K'] },
          { name: 'quality', type: 'boolean', value: false },
          { name: 'input_references', type: 'boolean', value: false },
        ],
      },
    ],
  },
};

export const openRouterImagenEndpointsFixture = {
  data: {
    id: 'google/imagen-4-fast',
    endpoints: [{
      provider_name: 'Google',
      provider_slug: 'google-ai-studio',
      provider_tag: 'google-ai-studio',
      capabilities: [{ name: 'aspect_ratio', type: 'enum', values: ['1:1', 42, '9:16'] }],
    }],
  },
};

export const malformedOpenRouterModelsFixture = { data: { id: 'not-an-array' } };
