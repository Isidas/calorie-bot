import type { IVisionProvider } from '../types';
import { GeminiProvider } from './gemini-provider';

export type { IVisionProvider };
export { GeminiProvider };

export function createVisionProvider(
  apiKey: string,
  modelName: string,
  timeoutMs?: number
): IVisionProvider {
  return new GeminiProvider(apiKey, modelName, timeoutMs ?? 30_000);
}
