export const UNSUPPORTED_RESPONSE_PARAMS = new Set([
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "service_tier",
  "temperature"
]);

export function stripUnsupportedParams<T extends Record<string, unknown>>(payload: T): T {
  const stripped = { ...payload };
  for (const key of UNSUPPORTED_RESPONSE_PARAMS) {
    delete stripped[key];
  }
  return stripped;
}
