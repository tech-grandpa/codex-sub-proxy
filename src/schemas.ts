import { HttpError } from "./http.js";

export interface ResponsesEvent {
  type: string;
  delta?: string;
  text?: string;
  response?: Record<string, unknown>;
  item?: Record<string, unknown>;
  output_index?: number;
  content_index?: number;
  error?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseResponsesRequest(value: unknown): Record<string, unknown> {
  const request = parseRequestObject(value);
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new HttpError(400, "invalid_request", "model is required");
  }
  if (!("input" in request)) {
    throw new HttpError(400, "invalid_request", "input is required");
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new HttpError(400, "invalid_request", "stream must be a boolean");
  }
  return request;
}

export function parseChatRequest(value: unknown): Record<string, unknown> {
  const request = parseRequestObject(value);
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new HttpError(400, "invalid_request", "stream must be a boolean");
  }
  return request;
}

export function parseResponsesEvent(value: unknown): ResponsesEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(502, "upstream_protocol_error", "Upstream SSE data must be a JSON object");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || event.type === "") {
    throw new HttpError(502, "upstream_protocol_error", "Upstream SSE event is missing a type");
  }
  for (const key of ["output_index", "content_index"] as const) {
    if (event[key] !== undefined && !Number.isInteger(event[key])) {
      throw new HttpError(502, "upstream_protocol_error", `Upstream SSE ${key} must be an integer`);
    }
  }
  return event as ResponsesEvent;
}

function parseRequestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}
