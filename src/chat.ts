import { randomUUID } from "node:crypto";

import { HttpError, isPlainObject } from "./http.js";

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

// Responses fields that are forwarded verbatim from a chat.completions request.
// Everything else is either translated below or dropped, because the Codex
// backend rejects unknown top-level fields with a 400. Fields the backend
// rejects even though they are valid Responses fields (temperature,
// max_output_tokens, metadata, ...) are removed later by stripUnsupportedParams,
// so they are deliberately not listed here.
const RESPONSES_PASSTHROUGH_FIELDS = [
  "reasoning",
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
      if (content.length > 0 || toolCalls.length === 0) {
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

  const payload: ResponsesPayload = {
    model: request.model,
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input,
    stream: request.stream === true
  };

  for (const field of RESPONSES_PASSTHROUGH_FIELDS) {
    const value = request[field];
    if (value !== undefined) payload[field] = value;
  }

  if (typeof request.reasoning_effort === "string") {
    const reasoning = isPlainObject(payload.reasoning) ? { ...payload.reasoning } : {};
    reasoning.effort = request.reasoning_effort;
    payload.reasoning = reasoning;
  }

  const text = buildTextOptions(request);
  if (text) payload.text = text;

  if (request.tools !== undefined) {
    payload.tools = parseChatTools(request.tools);
  }
  if (request.tool_choice !== undefined) {
    payload.tool_choice = normalizeChatToolChoice(request.tool_choice);
  }

  return applyChatWebSearchOptions(payload);
}

// Chat `response_format` and `verbosity` live under `text` in the Responses API.
function buildTextOptions(request: ChatCompletionRequest): Record<string, unknown> | undefined {
  if (request.text !== undefined && !isPlainObject(request.text)) {
    throw new HttpError(400, "invalid_request", "text must be an object");
  }

  const text: Record<string, unknown> = isPlainObject(request.text) ? { ...request.text } : {};

  if (request.response_format !== undefined) {
    text.format = chatResponseFormatToTextFormat(request.response_format);
  }

  if (request.verbosity !== undefined) {
    if (typeof request.verbosity !== "string") {
      throw new HttpError(400, "invalid_request", "verbosity must be a string");
    }
    text.verbosity = request.verbosity;
  }

  return Object.keys(text).length > 0 ? text : undefined;
}

function chatResponseFormatToTextFormat(format: unknown): Record<string, unknown> {
  if (!isPlainObject(format)) {
    throw new HttpError(400, "invalid_request", "response_format must be an object");
  }

  if (format.type === "text" || format.type === "json_object") {
    return { type: format.type };
  }

  if (format.type === "json_schema") {
    const schema = format.json_schema;
    if (!isPlainObject(schema) || typeof schema.name !== "string" || !schema.name) {
      throw new HttpError(400, "invalid_request", "response_format.json_schema.name is required");
    }
    const textFormat: Record<string, unknown> = { type: "json_schema", name: schema.name };
    if (schema.schema !== undefined) textFormat.schema = schema.schema;
    if (typeof schema.description === "string") textFormat.description = schema.description;
    if (typeof schema.strict === "boolean") textFormat.strict = schema.strict;
    return textFormat;
  }

  throw new HttpError(400, "invalid_request", `Unsupported response_format type: ${String(format.type)}`);
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
        finish_reason: chatFinishReason(response, toolCalls.length > 0)
      }
    ],
    usage: toChatUsage(isPlainObject(response) ? response.usage : undefined)
  };
}

interface AssistantParts {
  text: string;
  toolCalls: Record<string, unknown>[];
}

function extractAssistantParts(response: unknown): AssistantParts {
  if (!isPlainObject(response)) return { text: "", toolCalls: [] };

  const toolCalls: Record<string, unknown>[] = [];
  const parts: string[] = [];

  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!isPlainObject(item)) continue;

    if (item.type === "function_call") {
      toolCalls.push({
        id: toolCallId(item),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      });
      continue;
    }

    // Only assistant message text is content; reasoning items also carry text parts.
    if (item.type !== undefined && item.type !== "message") continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isPlainObject(part)) continue;
      if (part.type !== undefined && part.type !== "output_text" && part.type !== "text") continue;
      if (typeof part.text === "string") parts.push(part.text);
    }
  }

  const text = typeof response.output_text === "string" ? response.output_text : parts.join("");
  return { text, toolCalls };
}

export function extractOutputText(response: unknown): string {
  return extractAssistantParts(response).text;
}

export function toolCallId(item: Record<string, unknown>): string {
  if (typeof item.call_id === "string") return item.call_id;
  if (typeof item.id === "string") return item.id;
  return `call_${randomUUID().replaceAll("-", "")}`;
}

// A truncated response reports "length" even when it contains tool calls,
// because the last call's arguments may be cut off.
export function chatFinishReason(response: unknown, hasToolCalls: boolean): string {
  if (isPlainObject(response) && response.status === "incomplete") {
    const details = response.incomplete_details;
    return isPlainObject(details) && details.reason === "content_filter" ? "content_filter" : "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

// Convert Responses usage (input/output tokens) into Chat Completions usage
// (prompt/completion tokens).
export function toChatUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(usage)) return undefined;

  const promptTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const completionTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens);
  const chatUsage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens
  };

  const inputDetails = usage.input_tokens_details;
  if (isPlainObject(inputDetails) && typeof inputDetails.cached_tokens === "number") {
    chatUsage.prompt_tokens_details = { cached_tokens: inputDetails.cached_tokens };
  }
  const outputDetails = usage.output_tokens_details;
  if (isPlainObject(outputDetails) && typeof outputDetails.reasoning_tokens === "number") {
    chatUsage.completion_tokens_details = { reasoning_tokens: outputDetails.reasoning_tokens };
  }

  return chatUsage;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
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
