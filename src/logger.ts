export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => console.log(line)) {
    this.write = write;
  }

  info(event: string, fields: LogFields = {}): void {
    this.emit("info", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.emit("error", event, fields);
  }

  private emit(level: string, event: string, fields: LogFields): void {
    this.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...(redact(fields) as LogFields) }));
  }
}

export const silentLogger: Logger = {
  info() {},
  error() {},
};

function redact(value: unknown, key = "", depth = 0): unknown {
  if (/authorization|token|secret|api.?key|body|payload/i.test(key)) return "[REDACTED]";
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]),
    );
  }
  return value;
}
