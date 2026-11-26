// @ts-check
import { warn } from './core.js';
import { fitReferencesToWireBudget, wireBodyBytes } from './references.js';
import { wireBodyBudget, noteWireBodyLimit } from './connection-evidence.js';
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

// Inline-image contracts with a documented request ceiling: the Gemini API
// caps a request carrying inline data at 20 MB. A learned gateway limit belongs
// to the connection and applies to every contract.
const INLINE_BODY_BUDGET = new Map([
  ['gemini-native', 18 * 1024 * 1024],
  ['gemini-interactions', 18 * 1024 * 1024],
]);
// A budget no body can meet: moves every reference to the wire tier.
const TIER_ALL_BUDGET = 1;

/**
 * Wire-copy fitting for body-limited connections, shared by every contract.
 * Only the copy for this dispatch is tiered down; the stored references stay
 * untouched.
 * @param {Function} adapter
 * @param {object} invocation
 * @param {{ fit?: Function }} [deps] test seam
 */
export async function dispatchWithWireFit(adapter, invocation, { fit = fitReferencesToWireBudget } = {}) {
  const prompt = String(invocation.request?.prompt || '');
  const connId = invocation.diagnostic?.connId;
  const references = invocation.parsedReferences;
  if (references.length) {
    const budget = (await wireBodyBudget(connId)) ?? INLINE_BODY_BUDGET.get(invocation.route?.generationContract) ?? null;
    const fitted = budget ? await fit(references, budget, prompt) : null;
    const moved = fitted ? fitted.filter((reference, index) => reference !== references[index]).length : 0;
    if (moved) {
      warn(`wire-body-limit: connection ${connId}: body fitted under ${budget} B (${moved} of ${references.length} references moved to the wire tier, store untouched)`);
      invocation = { ...invocation, parsedReferences: fitted };
    }
  }
  try {
    return await adapter(invocation);
  } catch (error) {
    // 413 is a size rejection before anything was generated or billed, so one
    // retry with every reference at the wire tier is safe. The learned budget
    // then keeps this connection's later dispatches under the limit from the
    // start.
    if (error?.httpStatus !== 413 || !references.length) throw error;
    const sent = invocation.parsedReferences;
    const failedBytes = wireBodyBytes(sent, prompt);
    const tiered = await fit(sent, TIER_ALL_BUDGET, prompt);
    if (tiered.every((reference, index) => reference === sent[index])) throw error;
    warn(`wire-body-limit: HTTP 413 at ~${failedBytes} B — budget learned, references tiered, dispatched once more`);
    if (connId) noteWireBodyLimit(connId, failedBytes).catch(() => {});
    return adapter({ ...invocation, parsedReferences: tiered });
  }
}

/**
 * Invoke exactly the persisted route contract. This registry never chooses an
 * adapter from the endpoint, provider name, or model ID.
 */
export async function invokeImageProvider(input) {
  const adapter = validateImageProviderInvocation(input);
  const transport = input.transport || transportWithAttemptStamping(defaultTransport, input);
  return dispatchWithWireFit(adapter, { ...input, transport, diagnostic: input.diagnostic || null });
}
