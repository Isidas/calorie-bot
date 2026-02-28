/** Коды ошибок, при которых имеет смысл повторить запрос к Telegram */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPROTO',
  'ENETUNREACH',
]);

/** Задержки перед повторной попыткой: 300, 900, 1800 ms (экспоненциально) + jitter */
const DELAYS_MS = [300, 900, 1800];
const MAX_ATTEMPTS = DELAYS_MS.length + 1;

function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as NodeJS.ErrnoException & { cause?: { code?: string }; status?: number };
    if (e.code && RETRYABLE_NETWORK_CODES.has(e.code)) return true;
    if (e.cause && typeof e.cause === 'object' && 'code' in e.cause && RETRYABLE_NETWORK_CODES.has((e.cause as { code: string }).code)) return true;
    if (typeof e.status === 'number') {
      if (e.status === 429) return true;
      if (e.status >= 500 && e.status < 600) return true;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT') || message.includes('network') || message.includes('ECONNREFUSED')) return true;
  if (message.includes('429')) return true;
  if (/failed: 5\d\d/.test(message) || /status.*5\d\d/.test(message)) return true;
  return false;
}

/** Случайный jitter ±20% от задержки (минимум 0) */
function jitter(ms: number): number {
  const spread = Math.floor(ms * 0.2);
  const delta = spread > 0 ? Math.floor(Math.random() * (2 * spread + 1)) - spread : 0;
  return Math.max(0, ms + delta);
}

/**
 * Выполняет fn до MAX_ATTEMPTS раз при сетевых ошибках, 5xx и 429.
 * Задержки: 300, 900, 1800 ms (с jitter) перед 2-й, 3-й и 4-й попыткой.
 */
export async function withTelegramRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        const delayMs = jitter(DELAYS_MS[attempt - 1]);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}
