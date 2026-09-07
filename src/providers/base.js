// @ts-check
/**
 * Shared text-provider contract.
 */

/**
 * @typedef {Object} TextProfile
 * @property {'openai-like' | 'gemini'} provider
 * @property {string} endpoint - Base URL of the provider API.
 * @property {string} apiKey - API key used for authentication.
 * @property {string} model - Model identifier.
 * @property {number} [temperature] - Optional sampling temperature.
 */
