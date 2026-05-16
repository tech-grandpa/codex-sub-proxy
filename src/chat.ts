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
  web_search_options?: unknown;
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
  content: ResponseInputContent;
}

export type ResponseInputContent = string | ResponseContentPart[];

export interface ResponseContentPart {
  type: string;
  [key: string]: unknown;
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

    if (message.role === "system" || message.role === "developer") {
      const content = normalizeInstructionContent(message.content);
      if (content) instructions.push(content);
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      const content = normalizeContent(message.content);
      input.push({ role: message.role, content });
      continue;
    }

    throw new HttpError(400, "invalid_request", `Unsupported chat message role: ${message.role}`);
  }

  const { messages: _messages, ...rest } = request;
  const payload = {
    ...rest,
    model: request.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input,
    stream: request.stream === true
  };

  return applyChatWebSearchOptions(payload);
}

function applyChatWebSearchOptions(payload: ResponsesPayload): ResponsesPayload {
  if (payload.web_search_options == null) return payload;

  const { web_search_options: webSearchOptions, ...rest } = payload;
  if (rest.tools !== undefined) return rest as ResponsesPayload;

  const webSearchTool = chatWebSearchOptionsToResponsesTool(webSearchOptions);

  return {
    ...rest,
    tools: [webSearchTool],
    tool_choice: rest.tool_choice ?? "auto"
  };
}

function chatWebSearchOptionsToResponsesTool(options: unknown): ResponseContentPart {
  const tool: ResponseContentPart = { type: "web_search" };
  if (!options || typeof options !== "object" || Array.isArray(options)) return tool;

  const object = options as Record<string, unknown>;
  if (typeof object.search_context_size === "string") {
    tool.search_context_size = object.search_context_size;
  }

  const userLocation = normalizeWebSearchUserLocation(object.user_location);
  if (userLocation) {
    tool.user_location = userLocation;
  }

  return tool;
}

function normalizeWebSearchUserLocation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const object = value as Record<string, unknown>;
  const approximate = object.approximate;
  if (object.type === "approximate" && approximate && typeof approximate === "object" && !Array.isArray(approximate)) {
    return {
      type: "approximate",
      ...(approximate as Record<string, unknown>)
    };
  }

  if (object.type === "approximate") {
    return { ...object };
  }

  return undefined;
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

function normalizeContent(content: unknown): ResponseInputContent {
  if (content == null) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = content
      .map(normalizeContentPart)
      .filter((part): part is ResponseContentPart => part !== undefined);

    if (parts.every((part) => part.type === "input_text")) {
      return parts
        .map((part) => typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
    }

    return parts;
  }

  return String(content);
}

function normalizeInstructionContent(content: unknown): string {
  const normalized = normalizeContent(content);
  if (typeof normalized === "string") return normalized;
  return normalized
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function normalizeContentPart(part: unknown): ResponseContentPart | undefined {
  if (typeof part === "string") {
    return { type: "input_text", text: part };
  }
  if (!part || typeof part !== "object") return undefined;

  const object = part as Record<string, unknown>;
  if (object.type === "input_text" || object.type === "input_file" || object.type === "input_image") {
    return { ...object, type: object.type };
  }

  if (object.type === "text" && typeof object.text === "string") {
    return { type: "input_text", text: object.text };
  }

  if (object.type === "file" && object.file && typeof object.file === "object" && !Array.isArray(object.file)) {
    return { type: "input_file", ...(object.file as Record<string, unknown>) };
  }

  if (typeof object.text === "string") {
    return { type: "input_text", text: object.text };
  }
  if (typeof object.content === "string") {
    return { type: "input_text", text: object.content };
  }

  return undefined;
}
