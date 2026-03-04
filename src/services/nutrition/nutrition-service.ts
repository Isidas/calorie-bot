import type { EstimatedMacros } from '../../types';
import type { IVisionProvider } from '../../types';
import type { CaloriesRange } from '../../types';
import type { DishIngredient } from '../../types';
import type { UsdaSearchHit } from './usda-client';
import { UsdaClient } from './usda-client';

export interface NutritionResult {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  calories_range: CaloriesRange;
  confidence: 'low' | 'medium' | 'high';
  assumptions: string[];
  fromDb: boolean;
}

/** Приоритет типа данных USDA: Foundation > SR Legacy > Survey > Branded */
const DATA_TYPE_ORDER: Record<string, number> = {
  foundation: 0,
  'sr legacy': 1,
  'foundation foods': 0,
  survey: 2,
  fndds: 2,
  branded: 3,
};

function dataTypeRank(dataType?: string): number {
  if (!dataType) return 2;
  const lower = dataType.toLowerCase();
  for (const [key, rank] of Object.entries(DATA_TYPE_ORDER)) {
    if (lower.includes(key)) return rank;
  }
  return 2;
}

/** Токены для простого сравнения (буквы/цифры, нижний регистр) */
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .split(' ')
      .filter(Boolean)
  );
}

function tokenOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap++;
  }
  return ta.size > 0 ? overlap / ta.size : 0;
}

/**
 * Выбирает лучший результат поиска: приоритет dataType (Foundation > SR Legacy > Survey > Branded),
 * затем текстовая похожесть description к query (token overlap).
 */
export function chooseBestMatch(results: UsdaSearchHit[], query: string): UsdaSearchHit[] {
  const q = query.trim().toLowerCase();
  return [...results].sort((a, b) => {
    const rankA = dataTypeRank(a.dataType);
    const rankB = dataTypeRank(b.dataType);
    if (rankA !== rankB) return rankA - rankB;
    const scoreA = a.score ?? tokenOverlap(a.description, q);
    const scoreB = b.score ?? tokenOverlap(b.description, q);
    return scoreB - scoreA;
  });
}

function scaleNutrients(
  per100: { calories: number; protein: number; fat: number; carbs: number },
  portionGrams: number
): EstimatedMacros {
  const k = portionGrams / 100;
  return {
    calories: Math.round(per100.calories * k),
    protein: Math.round(per100.protein * k * 10) / 10,
    fat: Math.round(per100.fat * k * 10) / 10,
    carbs: Math.round(per100.carbs * k * 10) / 10,
  };
}

type Confidence = 'low' | 'medium' | 'high';

/** Диапазон калорий по уверенности: high ±15%, medium ±25%, low ±40%. fromDb=false всегда low ±40%. */
function toCaloriesRange(
  cal: number,
  confidence: Confidence,
  fromDb: boolean
): CaloriesRange {
  if (cal <= 0) return { min: 0, max: 0 };
  const pct = fromDb
    ? confidence === 'high'
      ? 0.15
      : confidence === 'medium'
        ? 0.25
        : 0.4
    : 0.4;
  const delta = Math.max(20, Math.round(cal * pct));
  return { min: Math.max(0, cal - delta), max: cal + delta };
}

function lowerConfidence(c: Confidence): Confidence {
  if (c === 'high') return 'medium';
  if (c === 'medium') return 'low';
  return 'low';
}

/** Блюда, которые нужно разбивать на ингредиенты */
const COMPOSITE_DISH_KEYWORDS = [
  // Русские
  'винегрет', 'борщ', 'щи', 'солянка', 'рассольник', 'окрошка',
  'оливье', 'салат', 'запеканка', 'рагу', 'плов', 'рис',
  'паста', 'лазанья', 'пицца', 'суп', 'похлёбка', 'уха',
  'голубцы', 'долма', 'пельмени', 'вареники', 'манты',
  'жаркое', 'гуляш', 'тушёное', 'тушёный', 'тушёная',
  // Английские (на случай если dish пришёл на английском)
  'salad', 'soup', 'stew', 'casserole', 'pasta', 'pizza',
  'pilaf', 'borscht', 'vinaigrette', 'lasagna',
];

function isCompositeDish(dishName: string): boolean {
  const lower = dishName.toLowerCase();
  return COMPOSITE_DISH_KEYWORDS.some((kw) => lower.includes(kw));
}

export class NutritionService {
  constructor(
    private usda: UsdaClient,
    private visionProvider: IVisionProvider | null,
    private enableGeminiFallback: boolean
  ) {}

  /** Получить КБЖУ одного ингредиента из USDA */
  private async getIngredientNutrition(
    ingredient: DishIngredient
  ): Promise<EstimatedMacros | null> {
    try {
      const hits = await this.usda.searchFoods(ingredient.searchQuery);
      const ordered = chooseBestMatch(hits, ingredient.searchQuery);
      for (const hit of ordered.slice(0, 3)) {
        try {
          const details = await this.usda.getFoodDetails(hit.fdcId);
          return scaleNutrients(details.nutrientsPer100g, ingredient.weightGrams);
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Считать КБЖУ по списку ингредиентов */
  private async getNutritionByIngredients(
    dishName: string,
    portionGrams: number,
    visionConfidence: Confidence
  ): Promise<NutritionResult | null> {
    if (!this.visionProvider?.decomposeIngredients) return null;

    const ingredients = await this.visionProvider.decomposeIngredients(dishName, portionGrams);
    if (ingredients.length < 2) return null;

    const results = await Promise.all(
      ingredients.map((ing) => this.getIngredientNutrition(ing))
    );

    // Считаем сколько ингредиентов нашли
    const found = results.filter((r) => r !== null);
    if (found.length < Math.ceil(ingredients.length * 0.5)) return null; // нашли меньше половины — не доверяем

    const totals = found.reduce(
      (acc, r) => ({
        calories: acc.calories + (r?.calories ?? 0),
        protein: acc.protein + (r?.protein ?? 0),
        fat: acc.fat + (r?.fat ?? 0),
        carbs: acc.carbs + (r?.carbs ?? 0),
      }),
      { calories: 0, protein: 0, fat: 0, carbs: 0 }
    );

    const foundIngredients = ingredients
      .filter((_, i) => results[i] !== null)
      .map((ing) => ing.name);

    const missedIngredients = ingredients
      .filter((_, i) => results[i] === null)
      .map((ing) => ing.name);

    const assumptions: string[] = [
      `Расчёт по ингредиентам: ${foundIngredients.join(', ')}.`,
    ];
    if (missedIngredients.length > 0) {
      assumptions.push(`Не найдено в базе (не учтено): ${missedIngredients.join(', ')}.`);
    }

    const confidence: Confidence = found.length === ingredients.length ? visionConfidence : 'medium';

    return {
      calories: Math.round(totals.calories),
      protein: Math.round(totals.protein * 10) / 10,
      fat: Math.round(totals.fat * 10) / 10,
      carbs: Math.round(totals.carbs * 10) / 10,
      calories_range: toCaloriesRange(Math.round(totals.calories), confidence, true),
      confidence,
      assumptions,
      fromDb: true,
    };
  }

  /**
   * Ищет в USDA по dishName и candidates (с chooseBestMatch), при неудаче — fallback через Gemini только если enableGeminiFallback.
   */
  async getNutrition(
    dishName: string,
    candidates: string[],
    portionGrams: number,
    visionConfidence: Confidence
  ): Promise<NutritionResult> {
    // Для составных блюд — сначала пробуем разбивку на ингредиенты
    if (isCompositeDish(dishName)) {
      try {
        const ingredientResult = await this.getNutritionByIngredients(
          dishName,
          portionGrams,
          visionConfidence
        );
        if (ingredientResult) return ingredientResult;
      } catch {
        // Fallback на обычный USDA поиск
      }
    }

    // Поиск USDA по английским candidates (dish приходит на русском для отображения)
    const queries = [
      ...candidates.filter((c) => c.trim()),
      dishName.trim(),
    ].filter(Boolean).slice(0, 6);

    for (const query of queries) {
      if (!query) continue;
      try {
        const hits = await this.usda.searchFoods(query);
        const ordered = chooseBestMatch(hits, query);
        for (const hit of ordered.slice(0, 5)) {
          try {
            const details = await this.usda.getFoodDetails(hit.fdcId);
            const per100 = details.nutrientsPer100g;
            const macros = scaleNutrients(per100, portionGrams);
            let confidence = visionConfidence;
            let productLabel = details.description;
            if (details.description && this.visionProvider?.translateToRussian) {
              try {
                const translated = await this.visionProvider.translateToRussian(details.description);
                if (translated) productLabel = translated;
              } catch {
                // оставляем оригинал
              }
            }
            const assumptions: string[] = [
              `Источник: база USDA. ${productLabel}`,
            ];
            if (portionGrams !== 100) {
              assumptions.push(`Порция ${portionGrams} г (расчёт от 100 г).`);
            }
            if (details.mayBePerServing) {
              assumptions.push('Значения в базе USDA могут быть указаны на порцию, а не на 100 г.');
              confidence = lowerConfidence(confidence);
            }
            return {
              ...macros,
              calories_range: toCaloriesRange(macros.calories, confidence, true),
              confidence,
              assumptions,
              fromDb: true,
            };
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    if (this.enableGeminiFallback && this.visionProvider?.estimateNutrition) {
      try {
        const estimated = await this.visionProvider.estimateNutrition(
          dishName,
          portionGrams
        );
        const assumptions: string[] = [
          'Совпадений в базе USDA нет; калорийность и БЖУ оценены нейросетью.',
        ];
        return {
          calories: estimated.calories,
          protein: estimated.protein,
          fat: estimated.fat,
          carbs: estimated.carbs,
          calories_range: toCaloriesRange(
            estimated.calories,
            'low',
            false
          ),
          confidence: 'low',
          assumptions,
          fromDb: false,
        };
      } catch {
        // Fallback failed (e.g. invalid JSON from Gemini)
      }
    }

    throw new Error('USDA_NO_MATCH');
  }
}
