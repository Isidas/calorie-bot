import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import type { IVisionProvider } from '../types';
import type { DishVision } from '../types';
import type { EstimatedMacros } from '../types';
import type { ImageMimeType } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;

const VISION_SYSTEM = `You are a food recognition expert. From the photo determine:
1. is_food (true/false) - is there a dish/food on the photo; if not (e.g. text, object) - false.
2. dish - main dish name ONLY in Russian, use Cyrillic. Examples: "аджарули хачапури", "куриная грудка на гриле", "спагетти карбонара". Never use English or Latin script for dish.
3. portion_grams - estimated portion weight in grams.
4. candidates - array of 2-5 search query strings in ENGLISH for a nutrition database (e.g. "chicken breast", "khachapuri", "pasta").
5. confidence - "low" | "medium" | "high" based on how clear the dish is.

Respond with STRICT JSON only, no markdown, no code blocks, no extra text.
Format: {"is_food":true,"dish":"только русскими буквами","portion_grams":number,"candidates":["english","query"],"confidence":"low|medium|high"}`;

const VISION_USER = 'Analyze this dish. Return ONLY valid JSON.';

const RETRY_USER = 'RETURN ONLY JSON. NO MARKDOWN. NO EXTRA TEXT.';

const ESTIMATE_PROMPT = (dish: string, portionGrams: number) =>
  `Estimate approximate nutrition for: "${dish}", portion ${portionGrams} g. Return ONLY valid JSON: {"calories":number,"protein":number,"fat":number,"carbs":number}. Numbers per whole portion. No other text.`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), ms)
    ),
  ]);
}

export class GeminiProvider implements IVisionProvider {
  private model: GenerativeModel;
  private timeoutMs: number;

  constructor(apiKey: string, modelName: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: modelName });
    this.timeoutMs = timeoutMs;
  }

  async analyzeDishFromImage(
    imageBuffer: Buffer,
    mimeType: ImageMimeType = 'image/jpeg'
  ): Promise<DishVision> {
    const base64 = imageBuffer.toString('base64');
    const content = await this.callVision(base64, mimeType, VISION_USER);
    const parsed = this.tryParseVision(content);
    if (parsed) return parsed;
    const retryContent = await this.callVision(base64, mimeType, RETRY_USER);
    const retryParsed = this.tryParseVision(retryContent);
    if (retryParsed) return retryParsed;
    throw new Error('Invalid JSON from vision');
  }

  /** Перевести короткую фразу (название продукта) на русский */
  async translateToRussian(text: string): Promise<string> {
    const t = text.trim();
    if (!t) return '';
    const prompt = `Translate to Russian in 2-6 words, only the translation, no quotes or explanation: ${t}`;
    try {
      const result = await withTimeout(
        this.model.generateContent(prompt),
        this.timeoutMs
      );
      const out = result.response.text()?.trim() ?? '';
      return out.replace(/^["']|["']$/g, '').trim() || t;
    } catch {
      return t;
    }
  }

  /** Fallback: оценить БЖУ по названию и порции, когда нет совпадения в БД */
  async estimateNutrition(dish: string, portionGrams: number): Promise<EstimatedMacros> {
    const json = await this.callText(ESTIMATE_PROMPT(dish, portionGrams));
    const raw = JSON.parse(json) as Record<string, unknown>;
    const num = (k: string) => {
      const v = raw[k];
      if (typeof v === 'number' && !Number.isNaN(v)) return Math.max(0, Math.round(v));
      if (typeof v === 'string') return Math.max(0, Math.round(parseFloat(v)) || 0);
      return 0;
    };
    return {
      calories: num('calories'),
      protein: num('protein'),
      fat: num('fat'),
      carbs: num('carbs'),
    };
  }

  private async callVision(
    base64: string,
    mimeType: ImageMimeType,
    userText: string
  ): Promise<string> {
    const prompt = `${VISION_SYSTEM}\n\n${userText}`;
    try {
      const result = await withTimeout(
        this.model.generateContent([
          { text: prompt },
          {
            inlineData: {
              data: base64,
              mimeType,
            },
          },
        ]),
        this.timeoutMs
      );
      const response = result.response;
      const text = response.text();
      if (!text?.trim()) throw new Error('Empty vision response');
      return text.trim();
    } catch (err) {
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined;
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
      console.error('[Calorie Bot] Gemini vision error:', { status, code });
      throw err;
    }
  }

  private async callText(prompt: string): Promise<string> {
    try {
      const result = await withTimeout(
        this.model.generateContent(prompt),
        this.timeoutMs
      );
      const text = result.response.text();
      if (!text?.trim()) throw new Error('Empty response');
      return this.extractJson(text.trim());
    } catch (err) {
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined;
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
      console.error('[Calorie Bot] Gemini text error:', { status, code });
      throw err;
    }
  }

  private tryParseVision(content: string): DishVision | null {
    try {
      const json = this.extractJson(content);
      return this.parseAndValidateVision(json);
    } catch {
      return null;
    }
  }

  private extractJson(text: string): string {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start === -1 || end <= start) throw new Error('No JSON in response');
    return text.slice(start, end);
  }

  private parseAndValidateVision(raw: string): DishVision {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Response is not an object');
    }
    const o = data as Record<string, unknown>;
    const is_food = o.is_food === true || String(o.is_food).toLowerCase() === 'true';
    const dish = String(o.dish ?? '').trim();
    const num = (key: string) => {
      const v = o[key];
      if (typeof v === 'number' && !Number.isNaN(v)) return Math.max(0, Math.round(v));
      if (typeof v === 'string') return Math.max(0, Math.round(parseFloat(v)) || 0);
      return 0;
    };
    const portion_grams = num('portion_grams');
    let candidates: string[] = [];
    if (Array.isArray(o.candidates)) {
      candidates = o.candidates
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
    }
    if (candidates.length === 0 && dish) candidates = [dish];
    const confRaw = String(o.confidence ?? 'medium').toLowerCase();
    const confidence: DishVision['confidence'] =
      confRaw === 'low' || confRaw === 'high' ? confRaw : 'medium';
    return {
      is_food,
      dish,
      portion_grams,
      candidates,
      confidence,
    };
  }
}
