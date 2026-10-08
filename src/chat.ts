import { randomUUID } from "node:crypto";

import { HttpError } from "./http.js";

export interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
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

export type ResponseInputItem = ResponseInputMessage | ResponseFunctionCall | ResponseFunctionCallOutput;

export interface ResponseInputMessage {
  role: "user" | "assistant";
  content: ResponseInputContent;
}

export interface ResponseFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

// Responses-API fields that the Codex backend accepts and that are safe to
// forward verbatim from a chat.completions request. Anything not listed here
// (or translated explicitly below) is dropped: the Codex backend rejects
// unknown top-level fields with a 400.
const RESPONSES_PASSTHROUGH_FIELDS = [
  "temperature",
  "max_output_tokens",
  "reasoning",
  "store",
  "metadata",
  "parallel_tool_calls",
  "prompt_cache_key",
  "truncation",
  "include",
  "web_search_options"
] as const;

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
      input.push({ role: message.role, content: normalizeContent(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      const content = normalizeContent(message.content);
      const toolCalls = parseChatToolCalls(message.tool_calls);
      const hasContent = typeof content === "string" ? content.length > 0 : content.length > 0;
      if (hasContent || toolCalls.length === 0) {
        input.push({ role: message.role, content });
      }
      input.push(...toolCalls);
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: requireToolCallId(message),
        output: normalizeToolOutput(message.content)
      });
      continue;
    }

    throw new HttpError(400, "invalid_request", `Unsupported chat message role: ${message.role}`);
  }

  const {
    messages: _messages,
    reasoning_effort: reasoningEffort,
    max_tokens: chatMaxTokens,
    max_completion_tokens: chatMaxCompletionTokens,
    stream_options: _streamOptions,
    tools: chatTools,
    tool_choice: chatToolChoice,
    ...rest
  } = request;

  const payload: ResponsesPayload = {
    model: request.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input,
    stream: request.stream === true
  };

  for (const field of RESPONSES_PASSTHROUGH_FIELDS) {
    const value = rest[field];
    if (value !== undefined) payload[field] = value;
  }

  const maxOutputTokens = firstNumber(chatMaxTokens, chatMaxCompletionTokens);
  if (maxOutputTokens !== undefined && payload.max_output_tokens == null) {
    payload.max_output_tokens = maxOutputTokens;
  }

  if (typeof reasoningEffort === "string") {
    const reasoning = isPlainObject(payload.reasoning) ? { ...(payload.reasoning as Record<string, unknown>) } : {};
    reasoning.effort = reasoningEffort;
    payload.reasoning = reasoning;
  }

  if (chatTools !== undefined) {
    payload.tools = parseChatTools(chatTools);
  }
  if (chatToolChoice !== undefined) {
    payload.tool_choice = normalizeChatToolChoice(chatToolChoice);
  }

  return applyChatWebSearchOptions(payload);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseChatToolCalls(toolCalls: unknown): ResponseFunctionCall[] {
  if (toolCalls == null) return [];
  if (!Array.isArray(toolCalls)) {
    throw new HttpError(400, "invalid_request", "assistant message tool_calls must be an array");
  }

  return toolCalls.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new HttpError(400, "invalid_request", `tool_calls[${index}] must be an object`);
    }
    const fn = isPlainObject(raw.function) ? raw.function : {};
    const name = typeof raw.name === "string" ? raw.name : typeof fn.name === "string" ? fn.name : undefined;
    const callId = typeof raw.id === "string" ? raw.id : typeof raw.call_id === "string" ? raw.call_id : undefined;
    if (!callId) {
      throw new HttpError(400, "invalid_request", `tool_calls[${index}].id is required`);
    }
    if (!name) {
      throw new HttpError(400, "invalid_request", `tool_calls[${index}].function.name is required`);
    }
    const args = raw.arguments ?? fn.arguments;
    return {
      type: "function_call",
      call_id: callId,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
    };
  });
}

function requireToolCallId(message: ChatMessage): string {
  if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
    throw new HttpError(400, "invalid_request", "tool messages must include a tool_call_id");
  }
  return message.tool_call_id;
}

function normalizeToolOutput(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isPlainObject(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function parseChatTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) {
    throw new HttpError(400, "invalid_request", "tools must be an array");
  }

  return tools.map((tool, index) => {
    if (!isPlainObject(tool)) {
      throw new HttpError(400, "invalid_request", `tools[${index}] must be an object`);
    }

    // Responses-native tools (web_search, flat function shape, ...) pass through.
    if (tool.type === "function" && typeof tool.name === "string") return tool;
    if (typeof tool.type === "string" && tool.type !== "function") return tool;

    if (tool.type === "function" && isPlainObject(tool.function)) {
      const fn = tool.function;
      if (typeof fn.name !== "string" || !fn.name) {
        throw new HttpError(400, "invalid_request", `tools[${index}].function.name is required`);
      }
      const translated: Record<string, unknown> = { type: "function", name: fn.name };
      if (typeof fn.description === "string") translated.description = fn.description;
      if (fn.parameters !== undefined) translated.parameters = fn.parameters;
      if (typeof fn.strict === "boolean") translated.strict = fn.strict;
      return translated;
    }

    throw new HttpError(400, "invalid_request", `tools[${index}] is not a supported tool definition`);
  });
}

function normalizeChatToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice; // "auto" | "none" | "required"
  if (isPlainObject(choice)) {
    if (choice.type === "function" && isPlainObject(choice.function)) {
      const name = choice.function.name;
      if (typeof name === "string" && name) return { type: "function", name };
    }
    // Already Responses-shaped (or a newer chat shape the backend understands).
    return choice;
  }
  return choice;
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
  const { text, toolCalls } = extractAssistantParts(response);
  const created = Math.floor(Date.now() / 1000);

  // OpenAI returns null content for tool-call-only messages; plain text stays a string.
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 && text.length === 0 ? null : text
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : extractFinishReason(response)
      }
    ],
    usage: extractUsage(response)
  };
}

interface AssistantParts {
  text: string;
  toolCalls: Record<string, unknown>[];
}

function extractAssistantParts(response: unknown): AssistantParts {
  if (!response || typeof response !== "object") return { text: "", toolCalls: [] };
  const object = response as Record<string, unknown>;

  const toolCalls: Record<string, unknown>[] = [];
  const parts: string[] = [];

  const output = object.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const itemObject = item as Record<string, unknown>;

      if (itemObject.type === "function_call") {
        toolCalls.push({
          id:
            typeof itemObject.call_id === "string"
              ? itemObject.call_id
              : typeof itemObject.id === "string"
                ? itemObject.id
                : randomUUID(),
          type: "function",
          function: {
            name: typeof itemObject.name === "string" ? itemObject.name : "",
            arguments:
              typeof itemObject.arguments === "string"
                ? itemObject.arguments
                : JSON.stringify(itemObject.arguments ?? {})
          }
        });
        continue;
      }

      const content = itemObject.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }

  // The Codex backend echoes function-call arguments into the top-level
  // output_text convenience field; only trust it for text-only responses.
  if (toolCalls.length === 0 && typeof object.output_text === "string") {
    return { text: object.output_text, toolCalls };
  }

  return { text: parts.join(""), toolCalls };
}

export function extractOutputText(response: unknown): string {
  return extractAssistantParts(response).text;
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
    content: message.content,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id
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
