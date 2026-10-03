// @ts-check
import { generateChatCompletionImage } from './providers/image-chat-completions.js';
import { generateGeminiImage } from './providers/image-gemini.js';
import { generateOpenAIImage } from './providers/image-openai.js';
import { generateOpenRouterImage } from './providers/image-openrouter.js';
import { generatePollinationsImage } from './providers/image-pollinations.js';
import { generateNaisteraImage } from './providers/image-naistera.js';
import { generateComfyUIImage } from './providers/image-comfyui.js';
import { providerError, assertReferencePolicy, referencesFor } from './providers/image-base.js';
import * as defaultTransport from './image-transport.js';

const adapters = Object.freeze({
  'openai-images': generateOpenAIImage,
  'gemini-native': generateGeminiImage,
  'chat-completions': generateChatCompletionImage,
  'openrouter-images': generateOpenRouterImage,
  'pollinations-images': generatePollinationsImage,
  'naistera': generateNaisteraImage,
  'comfyui': generateComfyUIImage,
});

export function getImageProviderAdapter(generationContract) {
  return adapters[generationContract] ?? null;
}

export function validateImageProviderInvocation(input) {
  if (input?.route?.contractVersion !== 1) {
    throw providerError('UNSUPPORTED_CONTRACT_VERSION', 'The selected image route has an unsupported contract version. Re-select and save a supported route before generating.');
  }
  const contract = input?.route?.generationContract;
  const adapter = getImageProviderAdapter(contract);
  if (!adapter) throw providerError('UNSUPPORTED_GENERATION_CONTRACT', 'The selected image route has an unsupported generation contract. Re-select and save a supported contract before generating.');
  assertReferencePolicy(input.route, input.request);
  referencesFor(input.request);
  return adapter;
}

/**
 * Invoke exactly the persisted route contract. This registry never chooses an
 * adapter from the endpoint, provider name, or model ID.
 */
export async function invokeImageProvider(input) {
  const adapter = validateImageProviderInvocation(input);
  return adapter({ ...input, transport: input.transport || defaultTransport, diagnostic: input.diagnostic || null });
}
