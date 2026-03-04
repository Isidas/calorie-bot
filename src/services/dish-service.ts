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

    // Собираем все кандидаты: основной вариант + alternatives
    const allCandidates = [
      ...visionResult.candidates,
      ...visionResult.alternatives.flatMap((a) => a.candidates),
    ];
    const uniqueCandidates = [...new Set(allCandidates)].slice(0, 8);

    const nutritionResult = await this.nutrition.getNutrition(
      visionResult.dish,
      uniqueCandidates,
      visionResult.portion_grams,
      visionResult.confidence
    );

    // Пересчитываем диапазон калорий с учётом диапазона веса
    const portionMin = visionResult.portion_min || visionResult.portion_grams;
    const portionMax = visionResult.portion_max || visionResult.portion_grams;
    const weightRatio = portionMax > 0 && portionMin > 0 ? portionMax / portionMin : 1;
    const caloriesRangeMin = Math.round(nutritionResult.calories_range.min);
    const caloriesRangeMax = Math.round(nutritionResult.calories_range.max * Math.min(weightRatio, 1.5));

    // Если есть альтернативные варианты блюда — добавляем в assumptions
    const altAssumptions = visionResult.alternatives.slice(0, 2).map(
      (a) => `Возможно также: ${a.dish} (${a.confidence === 'high' ? 'вероятно' : 'менее вероятно'})`
    );

    const analysis: DishAnalysis = {
      is_food: true,
      dish: visionResult.dish,
      weight_grams: visionResult.portion_grams,
      calories: nutritionResult.calories,
      protein: nutritionResult.protein,
      fat: nutritionResult.fat,
      carbs: nutritionResult.carbs,
      calories_range: { min: caloriesRangeMin, max: caloriesRangeMax },
      confidence: nutritionResult.confidence,
      assumptions: [...nutritionResult.assumptions, ...altAssumptions],
    };
    saveToHistory(userId, analysis);
    return analysis;
  }
}
