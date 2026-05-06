import { randomUUID } from "node:crypto";

import { HttpError } from "./http.js";

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

export interface ResponsesPayload {
  model: string;
  instructions?: string;
  input: ResponseInputMessage[];
  stream: boolean;
  [key: string]: unknown;
}

export interface ResponseInputMessage {
  role: "user" | "assistant";
  content: string;
}

export function chatToResponsesPayload(request: ChatCompletionRequest): ResponsesPayload {
  if (typeof request.model !== "string" || !request.model) {
    throw new HttpError(400, "invalid_request", "model is required");
  }
  if (!Array.isArray(request.messages)) {
    throw new HttpError(400, "invalid_request", "messages must be an array");
  }

  const instructions: string[] = [];
  const input: ResponseInputMessage[] = [];

  for (const rawMessage of request.messages) {
    const message = parseChatMessage(rawMessage);
    const content = normalizeContent(message.content);

    if (message.role === "system" || message.role === "developer") {
      if (content) instructions.push(content);
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      input.push({ role: message.role, content });
      continue;
    }

    throw new HttpError(400, "invalid_request", `Unsupported chat message role: ${message.role}`);
  }

  const { messages: _messages, ...rest } = request;
  return {
    ...rest,
    model: request.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input,
    stream: request.stream === true
  };
}

export function responsesToChatCompletion(response: unknown, model: string): Record<string, unknown> {
  const content = extractOutputText(response);
  const created = Math.floor(Date.now() / 1000);

  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: extractFinishReason(response)
      }
    ],
    usage: extractUsage(response)
  };
}

export function extractOutputText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const object = response as Record<string, unknown>;

  if (typeof object.output_text === "string") {
    return object.output_text;
  }

  const output = object.output;
  if (!Array.isArray(output)) return "";

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partObject = part as Record<string, unknown>;
      const text = partObject.text;
      if (typeof text === "string") parts.push(text);
    }
  }

  return parts.join("");
}

function extractFinishReason(response: unknown): string {
  if (!response || typeof response !== "object") return "stop";
  const status = (response as Record<string, unknown>).status;
  return status === "incomplete" ? "length" : "stop";
}

function extractUsage(response: unknown): unknown {
  if (!response || typeof response !== "object") return undefined;
  return (response as Record<string, unknown>).usage;
}

function parseChatMessage(value: unknown): ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Each message must be an object");
  }

  const message = value as Record<string, unknown>;
  if (typeof message.role !== "string") {
    throw new HttpError(400, "invalid_request", "Each message must include a role");
  }

  return {
    role: message.role,
    content: message.content
  };
}

function normalizeContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const object = part as Record<string, unknown>;
        if (typeof object.text === "string") return object.text;
        if (typeof object.content === "string") return object.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content);
}
