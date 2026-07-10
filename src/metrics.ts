import type { UpstreamObserver, UpstreamResult } from "./codex-adapter.js";

export type RequestFailure = "client" | "upstream" | "timeout" | "cancelled" | "internal";

export class MetricsRegistry implements UpstreamObserver {
  private readonly requests = new Map<string, number>();
  private readonly requestDurationMs = new Map<string, number>();
  private readonly upstream = new Map<UpstreamResult, number>();
  private readonly upstreamDurationMs = new Map<UpstreamResult, number>();
  private readonly failures = new Map<string, number>();
  private activeStreams = 0;

  recordRequest(method: string, route: string, status: number, durationMs = 0): void {
    const key = `${method}\u0000${route}\u0000${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.requestDurationMs.set(key, (this.requestDurationMs.get(key) ?? 0) + durationMs);
  }

  record(result: UpstreamResult, durationMs = 0): void {
    this.upstream.set(result, (this.upstream.get(result) ?? 0) + 1);
    this.upstreamDurationMs.set(result, (this.upstreamDurationMs.get(result) ?? 0) + durationMs);
  }

  streamStarted(): void {
    this.activeStreams += 1;
  }

  recordFailure(route: string, failure: RequestFailure): void {
    const key = `${route}\u0000${failure}`;
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
  }

  streamFinished(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
  }

  render(): string {
    const lines = [
      "# HELP codex_proxy_http_requests_total HTTP requests handled.",
      "# TYPE codex_proxy_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requests].sort()) {
      const [method, route, status] = key.split("\u0000");
      lines.push(`codex_proxy_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
    }
    lines.push(
      "# HELP codex_proxy_http_request_duration_seconds HTTP request latency.",
      "# TYPE codex_proxy_http_request_duration_seconds summary",
    );
    for (const [key, count] of [...this.requests].sort()) {
      const [method, route, status] = key.split("\u0000");
      const labels = `method="${method}",route="${route}",status="${status}"`;
      lines.push(
        `codex_proxy_http_request_duration_seconds_sum{${labels}} ${(this.requestDurationMs.get(key) ?? 0) / 1000}`,
        `codex_proxy_http_request_duration_seconds_count{${labels}} ${count}`,
      );
    }
    lines.push(
      "# HELP codex_proxy_upstream_requests_total Codex upstream outcomes.",
      "# TYPE codex_proxy_upstream_requests_total counter",
    );
    for (const [result, count] of [...this.upstream].sort()) {
      lines.push(`codex_proxy_upstream_requests_total{result="${result}"} ${count}`);
    }
    lines.push(
      "# HELP codex_proxy_request_failures_total Request failures including failures after streaming headers.",
      "# TYPE codex_proxy_request_failures_total counter",
    );
    for (const [key, count] of [...this.failures].sort()) {
      const [route, failure] = key.split("\u0000");
      lines.push(`codex_proxy_request_failures_total{route="${route}",failure="${failure}"} ${count}`);
    }
    lines.push(
      "# HELP codex_proxy_upstream_duration_seconds Codex upstream latency.",
      "# TYPE codex_proxy_upstream_duration_seconds summary",
    );
    for (const [result, count] of [...this.upstream].sort()) {
      lines.push(
        `codex_proxy_upstream_duration_seconds_sum{result="${result}"} ${(this.upstreamDurationMs.get(result) ?? 0) / 1000}`,
        `codex_proxy_upstream_duration_seconds_count{result="${result}"} ${count}`,
      );
    }
    lines.push(
      "# HELP codex_proxy_active_streams Active downstream streams.",
      "# TYPE codex_proxy_active_streams gauge",
      `codex_proxy_active_streams ${this.activeStreams}`,
      "",
    );
    return lines.join("\n");
  }
}
