import { writeFile, rename, mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import logger from './logger.js';

// ── Timeout ─────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(`Timeout after ${ms}ms${label ? `: ${label}` : ''}`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Retry with exponential backoff ──────────────────────────────

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  maxDelayMs: 16000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxAttempts) break;

      if (opts.retryOn && !opts.retryOn(error)) break;

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1),
        opts.maxDelayMs
      );
      const jitter = Math.random() * delay * 0.1;

      opts.onRetry?.(attempt, error);
      logger.warn(`Retry ${attempt}/${opts.maxAttempts} after ${delay}ms`, {
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise<void>((r) => setTimeout(r, delay + jitter));
    }
  }

  throw lastError;
}

// ── HTTP retry helper ───────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    ) {
      return true;
    }
  }
  // Check for EtsyApiError or similar with statusCode
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as Record<string, unknown>).statusCode === 'number'
  ) {
    return RETRYABLE_STATUS_CODES.has(
      (error as Record<string, unknown>).statusCode as number
    );
  }
  return false;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; maxAttempts?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, maxAttempts = 3 } = options;

  return withRetry(
    async () => {
      const response = await withTimeout(
        fetch(url, init),
        timeoutMs,
        `fetch ${init.method ?? 'GET'} ${url}`
      );

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        const body = await response.text();
        const err = new Error(
          `HTTP ${response.status} on ${url}: ${body.slice(0, 200)}`
        );
        (err as unknown as Record<string, unknown>).statusCode = response.status;
        throw err;
      }

      return response;
    },
    {
      maxAttempts,
      retryOn: isRetryableError,
    }
  );
}

// ── Circuit Breaker ─────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
  name: string;
}

const DEFAULT_CIRCUIT: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
  halfOpenMaxAttempts: 1,
  name: 'default',
};

export class CircuitBreakerOpenError extends Error {
  public readonly circuitName: string;
  public readonly openSince: Date;

  constructor(name: string, openSince: Date) {
    super(
      `Circuit breaker "${name}" is open (since ${openSince.toISOString()}). ` +
      `Calls are blocked to prevent cascading failures.`
    );
    this.name = 'CircuitBreakerOpenError';
    this.circuitName = name;
    this.openSince = openSince;
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime: Date | null = null;
  private openedAt: Date | null = null;
  private halfOpenAttempts = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_CIRCUIT, ...options };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt?.getTime() ?? 0);
      if (elapsed >= this.options.resetTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenAttempts = 0;
        logger.info(`Circuit breaker "${this.options.name}" entering half-open state`);
      } else {
        throw new CircuitBreakerOpenError(
          this.options.name,
          this.openedAt ?? new Date()
        );
      }
    }

    if (this.state === 'half-open') {
      if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        this.trip();
        throw new CircuitBreakerOpenError(
          this.options.name,
          this.openedAt ?? new Date()
        );
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      logger.info(`Circuit breaker "${this.options.name}" recovered — closing`);
    }
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.openedAt = null;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.options.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = new Date();
    logger.error(
      `Circuit breaker "${this.options.name}" OPEN after ${this.failureCount} failures. ` +
      `Calls blocked for ${this.options.resetTimeoutMs}ms.`
    );
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
    logger.info(`Circuit breaker "${this.options.name}" manually reset`);
  }
}

// ── Atomic file writes ──────────────────────────────────────────

export async function atomicWriteFile(
  filePath: string,
  data: string
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;

  try {
    await writeFile(tmpPath, data, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: unknown
): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
}

// ── Safe JSON parse ─────────────────────────────────────────────

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn('JSON parse failed, using fallback', {
      preview: raw.slice(0, 100),
    });
    return fallback;
  }
}

export async function safeReadJson<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Dead Letter Queue ───────────────────────────────────────────

const DLQ_DIR = resolve(process.cwd(), 'state', 'dead-letter-queue');

export interface DeadLetterItem {
  id: string;
  stage: string;
  productId?: string;
  error: string;
  input: unknown;
  timestamp: string;
  retryCount: number;
}

export async function sendToDeadLetterQueue(
  stage: string,
  error: string,
  input: unknown,
  productId?: string
): Promise<void> {
  const item: DeadLetterItem = {
    id: randomUUID(),
    stage,
    productId,
    error,
    input,
    timestamp: new Date().toISOString(),
    retryCount: 0,
  };

  await mkdir(DLQ_DIR, { recursive: true });
  const filePath = join(DLQ_DIR, `${item.id}.json`);
  await atomicWriteJson(filePath, item);

  logger.warn('Item sent to dead letter queue', {
    id: item.id,
    stage,
    productId,
    error: error.slice(0, 200),
  });
}

export async function getDeadLetterItems(): Promise<DeadLetterItem[]> {
  const { readdir } = await import('node:fs/promises');
  const items: DeadLetterItem[] = [];

  try {
    const files = await readdir(DLQ_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const item = await safeReadJson<DeadLetterItem | null>(
        join(DLQ_DIR, file),
        null
      );
      if (item) items.push(item);
    }
  } catch {
    // DLQ directory doesn't exist yet
  }

  return items.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

// ── Graceful error isolation ────────────────────────────────────

export interface IsolatedResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function isolate<T>(
  label: string,
  fn: () => Promise<T>
): Promise<IsolatedResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${label}] failed: ${message}`);
    return { success: false, error: message };
  }
}
