import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import type { IVisionProvider } from '../types';
import type { DishVision } from '../types';
import type { EstimatedMacros } from '../types';
import type { ImageMimeType } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;

const VISION_SYSTEM = `You are a food recognition expert. Analyze the photo and return JSON with these fields:

1. is_food (true/false) - is there a dish/food on the photo.
2. variants - array of 1-3 dish variants ordered by confidence (most likely first). Each variant:
   - dish: dish name ONLY in Russian Cyrillic (e.g. "мясо по-французски", "спагетти карбонара")
   - candidates: 2-5 English search queries for nutrition database (e.g. ["chicken breast baked", "french style meat"])
   - confidence: "low" | "medium" | "high"
3. portion_min - minimum estimated portion weight in grams (conservative estimate)
4. portion_max - maximum estimated portion weight in grams (generous estimate)
5. size_clues - visible size references used for estimation (e.g. "standard dinner plate", "fork visible", "bowl 500ml")

Use visible objects (plate size, cutlery, glass) to estimate weight range. Be conservative.

Respond with STRICT JSON only, no markdown, no code blocks.
Format: {"is_food":true,"variants":[{"dish":"русское название","candidates":["english","query"],"confidence":"high"}],"portion_min":200,"portion_max":350,"size_clues":"standard plate"}

If not food: {"is_food":false,"variants":[],"portion_min":0,"portion_max":0,"size_clues":""}`;

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

    const num = (key: string) => {
      const v = o[key];
      if (typeof v === 'number' && !Number.isNaN(v)) return Math.max(0, Math.round(v));
      if (typeof v === 'string') return Math.max(0, Math.round(parseFloat(v)) || 0);
      return 0;
    };

    const parseConf = (v: unknown): DishVision['confidence'] => {
      const s = String(v ?? 'medium').toLowerCase();
      return s === 'low' || s === 'high' ? s : 'medium';
    };

    const parseCandidates = (arr: unknown): string[] => {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
    };

    // Новый формат: variants[]
    let dish = '';
    let candidates: string[] = [];
    let confidence: DishVision['confidence'] = 'medium';
    const alternatives: import('../types').DishAlternative[] = [];

    if (Array.isArray(o.variants) && o.variants.length > 0) {
      const variants = o.variants as Record<string, unknown>[];
      const first = variants[0];
      dish = String(first.dish ?? '').trim();
      candidates = parseCandidates(first.candidates);
      confidence = parseConf(first.confidence);

      for (const v of variants.slice(1)) {
        const altDish = String(v.dish ?? '').trim();
        if (altDish) {
          alternatives.push({
            dish: altDish,
            candidates: parseCandidates(v.candidates),
            confidence: parseConf(v.confidence),
          });
        }
      }
    } else {
      // Fallback на старый формат
      dish = String(o.dish ?? '').trim();
      candidates = parseCandidates(o.candidates);
      confidence = parseConf(o.confidence);
    }

    if (candidates.length === 0 && dish) candidates = [dish];

    const portion_min = num('portion_min') || num('portion_grams');
    const portion_max = num('portion_max') || portion_min;
    const portion_grams = Math.round((portion_min + portion_max) / 2) || portion_min;

    return {
      is_food,
      dish,
      portion_grams,
      portion_min,
      portion_max,
      candidates,
      confidence,
      alternatives,
    };
  }
}
