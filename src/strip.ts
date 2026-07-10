export const UNSUPPORTED_RESPONSE_PARAMS = new Set([
  "audio",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "max_output_tokens",
  "metadata",
  "modalities",
  "n",
  "prediction",
  "presence_penalty",
  "prompt_cache_retention",
  "seed",
  "service_tier",
  "stop",
  "temperature",
  "top_logprobs",
]);

export function stripUnsupportedParams<T extends Record<string, unknown>>(payload: T): T {
  const stripped = { ...payload };
  for (const key of UNSUPPORTED_RESPONSE_PARAMS) {
    delete stripped[key];
  }
  return stripped;
}
