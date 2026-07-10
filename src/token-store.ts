import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface TokenState {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface TokenStore {
  load(): Promise<TokenState>;
  save(state: TokenState): Promise<void>;
  withRefreshLock<T>(operation: () => Promise<T>): Promise<T>;
}

export class MemoryTokenStore implements TokenStore {
  private state: TokenState;
  private lock: Promise<void> = Promise.resolve();

  constructor(initial: TokenState = {}) {
    this.state = { ...initial };
  }

  async load(): Promise<TokenState> {
    return { ...this.state };
  }

  async save(state: TokenState): Promise<void> {
    this.state = { ...state };
  }

  async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

interface FileTokenStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class FileTokenStore implements TokenStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly initial: TokenState;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(filePath: string, initial: TokenState = {}, options: FileTokenStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.initial = { ...initial };
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async load(): Promise<TokenState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const value = JSON.parse(raw) as Record<string, unknown>;
      return {
        accessToken: typeof value.accessToken === "string" ? value.accessToken : undefined,
        refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : undefined,
        expiresAt:
          typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && value.expiresAt > 0
            ? value.expiresAt
            : undefined,
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { ...this.initial };
      throw error;
    }
  }

  async save(state: TokenState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for OAuth token refresh lock");
        await sleep(25);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (Date.now() - details.mtimeMs > this.staleLockMs) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
