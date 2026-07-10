import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { FileTokenStore } from "../src/token-store.js";
import { TokenManager } from "../src/upstream.js";

test("file token store persists rotated tokens atomically with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-token-"));
  const file = join(directory, "tokens.json");
  try {
    const store = new FileTokenStore(file, { refreshToken: "initial" });
    assert.deepEqual(await store.load(), { refreshToken: "initial" });
    await store.save({ accessToken: "access", refreshToken: "rotated", expiresAt: 123 });
    assert.deepEqual(await store.load(), { accessToken: "access", refreshToken: "rotated", expiresAt: 123 });
    assert.match(await readFile(file, "utf8"), /"rotated"/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file token store coordinates refresh across token manager instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-lock-"));
  const file = join(directory, "tokens.json");
  let refreshes = 0;
  const mockFetch: typeof fetch = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ access_token: "shared", refresh_token: "rotated", expires_in: 3600 }), {
      status: 200,
    });
  };
  const config = loadConfig({ OPENAI_REFRESH_TOKEN: "initial", OPENAI_TOKEN_FILE: file });
  try {
    const first = new TokenManager(config, mockFetch);
    const second = new TokenManager(config, mockFetch);
    assert.deepEqual(await Promise.all([first.getAccessToken(), second.getAccessToken()]), ["shared", "shared"]);
    assert.equal(refreshes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file token invalidation does not resurrect the initial environment access token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-invalidate-"));
  const file = join(directory, "tokens.json");
  let refreshes = 0;
  const mockFetch: typeof fetch = async () => {
    refreshes += 1;
    return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "rotated", expires_in: 3600 }), {
      status: 200,
    });
  };
  const config = loadConfig({
    OPENAI_ACCESS_TOKEN: "old-access",
    OPENAI_REFRESH_TOKEN: "initial-refresh",
    OPENAI_EXPIRES_AT: "9999999999",
    OPENAI_TOKEN_FILE: file,
  });
  try {
    const manager = new TokenManager(config, mockFetch);
    assert.equal(await manager.getAccessToken(), "old-access");
    await manager.invalidateAccessToken("old-access");
    assert.equal(await manager.getAccessToken(), "new-access");
    assert.equal(refreshes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
