import type { IncomingMessage, ServerResponse } from "node:http";

export interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...response.headers
  });
  res.end(payload);
}

export function errorResponse(error: unknown): JsonResponse {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          type: error.code,
          message: error.message
        }
      }
    };
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    status: 500,
    body: {
      error: {
        type: "internal_error",
        message
      }
    }
  };
}

export async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function notImplemented(message: string): JsonResponse {
  return {
    status: 501,
    body: {
      error: {
        type: "not_implemented",
        message
      }
    }
  };
}
