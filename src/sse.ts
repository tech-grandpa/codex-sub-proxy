import { HttpError } from "./http.js";
import { parseResponsesEvent, type ResponsesEvent } from "./schemas.js";

export class ResponsesSseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array | string): ResponsesEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.extract(false);
  }

  finish(): ResponsesEvent[] {
    this.buffer += this.decoder.decode();
    return this.extract(true);
  }

  private extract(flush: boolean): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
    let match = /\r?\n\r?\n/.exec(this.buffer);
    while (match) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = parseBlock(block);
      if (event) events.push(event);
      match = /\r?\n\r?\n/.exec(this.buffer);
    }

    if (flush && this.buffer.trim() !== "") {
      const event = parseBlock(this.buffer);
      if (event) events.push(event);
      this.buffer = "";
    }
    return events;
  }
}

export function collectResponsesSse(text: string): Record<string, unknown> {
  const decoder = new ResponsesSseDecoder();
  const events = [...decoder.push(text), ...decoder.finish()];
  let completed: Record<string, unknown> | undefined;
  let outputText = "";

  for (const event of events) {
    assertSuccessfulEvent(event);
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      outputText += event.delta;
    } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
      outputText = event.text;
    } else if (event.type === "response.completed" && event.response) {
      completed = event.response;
    }
  }

  if (completed) return outputText ? { ...completed, output_text: outputText } : completed;
  throw new HttpError(502, "upstream_protocol_error", "Upstream SSE ended without a completed response");
}

export function assertSuccessfulEvent(event: ResponsesEvent): void {
  if (event.type !== "error" && event.type !== "response.failed") return;
  const message =
    event.error && typeof event.error.message === "string" ? event.error.message : "Upstream response failed";
  throw new HttpError(502, "upstream_error", message);
}

function parseBlock(block: string): ResponsesEvent | undefined {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return undefined;
  const raw = data.join("\n");
  if (raw === "[DONE]") return undefined;
  try {
    return parseResponsesEvent(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "upstream_protocol_error", "Upstream sent malformed SSE JSON");
  }
}
