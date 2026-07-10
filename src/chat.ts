import { randomUUID } from "node:crypto";

import { HttpError } from "./http.js";

export interface ChatMessage {
  role: string;
  content: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
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
  input: ResponseInputItem[];
  stream: boolean;
  [key: string]: unknown;
}

export interface ResponseInputMessage {
  role: "user" | "assistant";
  content: ResponseInputContent;
}

export type ResponseInputItem = ResponseInputMessage | Record<string, unknown>;

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
  const input: ResponseInputItem[] = [];

  for (const rawMessage of request.messages) {
    const message = parseChatMessage(rawMessage);

    if (message.role === "system" || message.role === "developer") {
      const content = normalizeInstructionContent(message.content);
      if (content) instructions.push(content);
      continue;
    }

    if (message.role === "user") {
      const content = normalizeContent(message.content);
      input.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = normalizeAssistantToolCalls(message.toolCalls);
      if (message.content != null || toolCalls.length === 0) {
        input.push({ role: "assistant", content: normalizeContent(message.content) });
      }
      input.push(...toolCalls);
      continue;
    }

    if (message.role === "tool") {
      if (typeof message.toolCallId !== "string" || message.toolCallId === "") {
        throw new HttpError(400, "invalid_request", "Tool messages require tool_call_id");
      }
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: normalizeToolOutput(message.content),
      });
      continue;
    }

    throw new HttpError(400, "invalid_request", `Unsupported chat message role: ${message.role}`);
  }

  const { messages: _messages, stream_options: _streamOptions, ...rest } = request;
  const payload: ResponsesPayload = {
    ...rest,
    model: request.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input,
    stream: request.stream === true,
  };

  if (payload.tools !== undefined) payload.tools = normalizeChatTools(payload.tools);
  if (payload.tool_choice !== undefined) payload.tool_choice = normalizeChatToolChoice(payload.tool_choice);

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
    tool_choice: rest.tool_choice ?? "auto",
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
      ...(approximate as Record<string, unknown>),
    };
  }

  if (object.type === "approximate") {
    return { ...object };
  }

  return undefined;
}

export function responsesToChatCompletion(response: unknown, model: string): Record<string, unknown> {
  const message = extractAssistantMessage(response);
  const created = Math.floor(Date.now() / 1000);

  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: extractFinishReason(response, message.tool_calls !== undefined),
      },
    ],
    usage: responsesUsageToChatUsage(response),
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

function extractFinishReason(response: unknown, hasToolCalls = false): string {
  if (!response || typeof response !== "object") return "stop";
  const status = (response as Record<string, unknown>).status;
  if (status === "incomplete") return "length";
  return hasToolCalls ? "tool_calls" : "stop";
}

export function responsesUsageToChatUsage(response: unknown): unknown {
  if (!response || typeof response !== "object") return undefined;
  const usage = (response as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const value = usage as Record<string, unknown>;
  return {
    prompt_tokens: value.input_tokens ?? 0,
    completion_tokens: value.output_tokens ?? 0,
    total_tokens: value.total_tokens ?? 0,
    ...(value.input_tokens_details !== undefined ? { prompt_tokens_details: value.input_tokens_details } : {}),
    ...(value.output_tokens_details !== undefined ? { completion_tokens_details: value.output_tokens_details } : {}),
  };
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
    content: message.content,
    toolCalls: message.tool_calls,
    toolCallId: message.tool_call_id,
  };
}

export function extractAssistantMessage(response: unknown): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: extractOutputText(response) };
  if (!response || typeof response !== "object") return message;
  const output = (response as Record<string, unknown>).output;
  if (!Array.isArray(output)) return message;

  const toolCalls: Array<Record<string, unknown>> = [];
  const annotations: unknown[] = [];
  const nonTextOutput: unknown[] = [];
  let refusal: string | undefined;

  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "function_call" && typeof item.name === "string" && typeof item.arguments === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call_${randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type === "refusal" && typeof part.refusal === "string") refusal = part.refusal;
        if (Array.isArray(part.annotations)) annotations.push(...part.annotations);
        if (part.type !== "output_text" && part.type !== "refusal") nonTextOutput.push(part);
      }
      continue;
    }
    if (item.type !== "reasoning") nonTextOutput.push(item);
  }

  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (refusal !== undefined) message.refusal = refusal;
  if (message.content === "" && (toolCalls.length > 0 || refusal !== undefined)) message.content = null;
  if (annotations.length > 0) message.annotations = annotations;
  if (nonTextOutput.length > 0) message.response_output = nonTextOutput;
  return message;
}

function normalizeAssistantToolCalls(value: unknown): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_request", "tool_calls must be an array");
  return value.map((rawCall) => {
    if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) {
      throw new HttpError(400, "invalid_request", "Each tool call must be an object");
    }
    const call = rawCall as Record<string, unknown>;
    const fn = call.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
      throw new HttpError(400, "invalid_request", "Function tool calls require function details");
    }
    const details = fn as Record<string, unknown>;
    if (typeof call.id !== "string" || typeof details.name !== "string" || typeof details.arguments !== "string") {
      throw new HttpError(400, "invalid_request", "Function tool calls require id, name, and arguments");
    }
    return { type: "function_call", call_id: call.id, name: details.name, arguments: details.arguments };
  });
}

function normalizeToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    throw new HttpError(400, "invalid_request", "Tool message content must be serializable");
  }
}

function normalizeChatTools(value: unknown): unknown {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_request", "tools must be an array");
  return value.map((rawTool) => {
    if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) return rawTool;
    const tool = rawTool as Record<string, unknown>;
    if (
      tool.type !== "function" ||
      !tool.function ||
      typeof tool.function !== "object" ||
      Array.isArray(tool.function)
    ) {
      return tool;
    }
    return { type: "function", ...(tool.function as Record<string, unknown>) };
  });
}

function normalizeChatToolChoice(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = value as Record<string, unknown>;
  if (
    choice.type === "function" &&
    choice.function &&
    typeof choice.function === "object" &&
    !Array.isArray(choice.function)
  ) {
    const name = (choice.function as Record<string, unknown>).name;
    return typeof name === "string" ? { type: "function", name } : value;
  }
  return value;
}

function normalizeContent(content: unknown): ResponseInputContent {
  if (content == null) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = content.map(normalizeContentPart).filter((part): part is ResponseContentPart => part !== undefined);

    if (parts.every((part) => part.type === "input_text")) {
      return parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }

    return parts;
  }

  throw new HttpError(400, "invalid_request", "Message content must be a string, an array, or null");
}

function normalizeInstructionContent(content: unknown): string {
  const normalized = normalizeContent(content);
  if (typeof normalized === "string") return normalized;
  return normalized
    .map((part) => (typeof part.text === "string" ? part.text : ""))
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
