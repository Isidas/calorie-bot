import type { IVisionProvider } from '../types';
import type { DishAnalysis } from '../types';
import type { ImageMimeType } from '../types';
import type { NutritionService } from './nutrition/nutrition-service';
import { saveToHistory } from './history';
import { checkRateLimit, getRemainingSeconds } from './rate-limit';

const RATE_LIMIT_INTERVAL_MS = 10_000;

export class RateLimitError extends Error {
  constructor(public readonly remainingSeconds: number) {
    super(`Rate limit: try again in ${remainingSeconds}s`);
    this.name = 'RateLimitError';
  }
}

export class DishService {
  constructor(
    private vision: IVisionProvider,
    private nutrition: NutritionService
  ) {}

  async analyzeFromImage(
    imageBuffer: Buffer,
    userId: number,
    mimeType?: ImageMimeType
  ): Promise<DishAnalysis> {
    if (!checkRateLimit(userId, RATE_LIMIT_INTERVAL_MS)) {
      const remaining = getRemainingSeconds(userId, RATE_LIMIT_INTERVAL_MS);
      throw new RateLimitError(remaining);
    }

    const visionResult = await this.vision.analyzeDishFromImage(imageBuffer, mimeType);

    if (!visionResult.is_food) {
      const analysis: DishAnalysis = {
        is_food: false,
        dish: visionResult.dish || 'Не распознано',
        weight_grams: visionResult.portion_grams,
        calories: 0,
        protein: 0,
        fat: 0,
        carbs: 0,
        calories_range: { min: 0, max: 0 },
        confidence: visionResult.confidence,
        assumptions: ['На фото не распознано блюдо.'],
      };
      saveToHistory(userId, analysis);
      return analysis;
    }

    const nutritionResult = await this.nutrition.getNutrition(
      visionResult.dish,
      visionResult.candidates,
      visionResult.portion_grams,
      visionResult.confidence
    );

    const analysis: DishAnalysis = {
      is_food: true,
      dish: visionResult.dish,
      weight_grams: visionResult.portion_grams,
      calories: nutritionResult.calories,
      protein: nutritionResult.protein,
      fat: nutritionResult.fat,
      carbs: nutritionResult.carbs,
      calories_range: nutritionResult.calories_range,
      confidence: nutritionResult.confidence,
      assumptions: nutritionResult.assumptions,
    };
    saveToHistory(userId, analysis);
    return analysis;
  }
}
