/** Простой rate limit: 1 запрос на пользователя в заданный интервал (мс). */
const lastByUser = new Map<number, number>();

const DEFAULT_INTERVAL_MS = 10_000;

export function checkRateLimit(userId: number, intervalMs: number = DEFAULT_INTERVAL_MS): boolean {
  const now = Date.now();
  const last = lastByUser.get(userId);
  if (last != null && now - last < intervalMs) return false;
  lastByUser.set(userId, now);
  return true;
}

export function getRemainingSeconds(userId: number, intervalMs: number = DEFAULT_INTERVAL_MS): number {
  const last = lastByUser.get(userId);
  if (last == null) return 0;
  const elapsed = Date.now() - last;
  const remaining = Math.ceil((intervalMs - elapsed) / 1000);
  return Math.max(0, remaining);
}
