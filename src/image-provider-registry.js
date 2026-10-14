// @ts-check
import { generateChatCompletionImage } from './providers/image-chat-completions.js';
import { generateGeminiImage, generateGeminiInteractionsImage } from './providers/image-gemini.js';
import { generateOpenAIImage } from './providers/image-openai.js';
import { generateOpenRouterImage } from './providers/image-openrouter.js';
import { generatePollinationsImage } from './providers/image-pollinations.js';
import { generateNaisteraImage } from './providers/image-naistera.js';
import { generateComfyUIImage } from './providers/image-comfyui.js';
import { generateCloudflareImage } from './providers/image-cloudflare.js';
import { providerError, assertReferencePolicy, referencesFor } from './providers/image-base.js';
import * as defaultTransport from './image-transport.js';

const adapters = Object.freeze({
  'openai-images': generateOpenAIImage,
  'gemini-native': generateGeminiImage,
  'gemini-interactions': generateGeminiInteractionsImage,
  'chat-completions': generateChatCompletionImage,
  'openrouter-images': generateOpenRouterImage,
  'pollinations-images': generatePollinationsImage,
  'naistera': generateNaisteraImage,
  'comfyui': generateComfyUIImage,
  'cloudflare-workers-ai': generateCloudflareImage,
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
  // Парсим data-URL (мегабайтные строки) ОДИН раз и штампуем в invocation —
  // иначе каждый адаптер парсит те же референсы повторно (пункт 18 плана).
  input.parsedReferences = referencesFor(input.request);
  return adapter;
}

/**
 * Пункт 2.2 плана 2026-10-05: транспорт возвращает факт доставки. Обёртка
 * дефолтного транспорта читает response.__urisAttempt (ставит
 * image-transport.js) и переносит finalDelivery на invocation.request.delivery
 * — image-api.js зеркалит штамп в finally. Адаптеры, шлющие несколько ног
 * (диалектная цепочка), штампуются каждой удавшейся ногой: побеждает
 * фактическая доставка той ноги, чей ответ вернулся наверх. Инжектированный
 * (тестовый) транспорт не оборачивается — его контракт не меняется.
 */
function transportWithAttemptStamping(transport, invocation) {
    const stampFrom = response => {
        const attempt = response?.__urisAttempt;
        if (attempt && invocation?.request && typeof invocation.request === 'object'
            && (attempt.finalDelivery === 'proxy' || attempt.finalDelivery === 'direct')) {
            invocation.request.delivery = attempt.finalDelivery;
        }
        return response;
    };
    const wrap = fn => (...args) => Promise.resolve(fn(...args)).then(stampFrom);
    return {
        ...transport,
        requestJson: wrap(transport.requestJson),
        requestMultipart: wrap(transport.requestMultipart),
    };
}

export { transportWithAttemptStamping };

/**
 * Invoke exactly the persisted route contract. This registry never chooses an
 * adapter from the endpoint, provider name, or model ID.
 */
export async function invokeImageProvider(input) {
  const adapter = validateImageProviderInvocation(input);
  const transport = input.transport || transportWithAttemptStamping(defaultTransport, input);
  return adapter({ ...input, transport, diagnostic: input.diagnostic || null });
}
