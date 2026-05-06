import type { IncomingHttpHeaders } from "node:http";

import { HttpError } from "./http.js";

export function validateProxyAuth(headers: IncomingHttpHeaders, proxyApiKey: string | undefined): void {
  if (!proxyApiKey) return;

  const authorization = singleHeader(headers.authorization);
  if (authorization !== `Bearer ${proxyApiKey}`) {
    throw new HttpError(401, "unauthorized", "Missing or invalid bearer token");
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
