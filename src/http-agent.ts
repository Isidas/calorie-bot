/**
 * Global HTTP keep-alive agent (undici) for reuse of connections to Telegram and USDA.
 */
import { Agent, fetch as undiciFetch } from 'undici';

const keepAliveAgent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
});

/**
 * fetch with shared keep-alive agent for connection reuse (Telegram, USDA).
 */
export async function fetchWithKeepAlive(
  url: string | URL,
  init?: RequestInit & { dispatcher?: Agent }
): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: keepAliveAgent });
}
