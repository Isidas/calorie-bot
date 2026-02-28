/**
 * USDA FoodData Central API client.
 * @see https://fdc.nal.usda.gov/api-guide.html
 */
import { fetchWithKeepAlive } from '../../http-agent';

const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const USDA_FOOD_URL = 'https://api.nal.usda.gov/fdc/v1/food';

/** Nutrient IDs in FDC (per 100g in details) */
const NUTRIENT_IDS = {
  ENERGY_KCAL: 1008,
  PROTEIN: 1003,
  TOTAL_FAT: 1004,
  CARBOHYDRATES: 1005,
} as const;

export interface UsdaSearchHit {
  fdcId: number;
  description: string;
  dataType?: string;
  score?: number;
}

export interface NutrientsPer100g {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

export interface UsdaFoodDetails {
  description: string;
  nutrientsPer100g: NutrientsPer100g;
  /** Если присутствует и не 100 — значения могут быть per serving, не per 100g */
  servingSize?: number;
  /** true если есть servingSize и он не 100 (нет явной базы 100g) */
  mayBePerServing?: boolean;
}

function getByNutrientId(nutrients: { nutrient?: { id?: number }; amount?: number }[], id: number): number {
  const n = nutrients?.find((x) => x.nutrient?.id === id);
  const v = n?.amount;
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  return 0;
}

function allNutrientsZero(n: NutrientsPer100g): boolean {
  return n.calories <= 0 && n.protein <= 0 && n.fat <= 0 && n.carbs <= 0;
}

export class UsdaClient {
  constructor(
    private apiKey: string,
    private timeoutMs: number
  ) {}

  /**
   * Search foods by query. Returns list of fdcId, description, and optionally dataType, score.
   */
  async searchFoods(query: string): Promise<UsdaSearchHit[]> {
    const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetchWithKeepAlive(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), pageSize: 10 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`USDA search failed: ${res.status} ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        foods?: {
          fdcId?: number;
          description?: string;
          dataType?: string;
          score?: number;
        }[];
      };
      const foods = data.foods ?? [];
      return foods
        .filter((f) => f.fdcId != null && f.description)
        .map((f) => ({
          fdcId: f.fdcId!,
          description: String(f.description).trim(),
          ...(f.dataType != null && { dataType: String(f.dataType) }),
          ...(typeof f.score === 'number' && !Number.isNaN(f.score) && { score: f.score }),
        }));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get food details and nutrients. If amounts are missing or all zeros, throws INVALID_NUTRIENTS.
   * Returns servingSize and mayBePerServing when servingSize is present and not 100.
   */
  async getFoodDetails(fdcId: number): Promise<UsdaFoodDetails> {
    const url = `${USDA_FOOD_URL}/${fdcId}?api_key=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetchWithKeepAlive(url, { signal: controller.signal });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`USDA food details failed: ${res.status} ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        description?: string;
        servingSize?: number;
        foodNutrients?: { nutrient?: { id?: number }; amount?: number }[];
      };
      const foodNutrients = data.foodNutrients ?? [];
      const nutrientsPer100g: NutrientsPer100g = {
        calories: getByNutrientId(foodNutrients, NUTRIENT_IDS.ENERGY_KCAL),
        protein: getByNutrientId(foodNutrients, NUTRIENT_IDS.PROTEIN),
        fat: getByNutrientId(foodNutrients, NUTRIENT_IDS.TOTAL_FAT),
        carbs: getByNutrientId(foodNutrients, NUTRIENT_IDS.CARBOHYDRATES),
      };
      if (allNutrientsZero(nutrientsPer100g)) {
        throw new Error('USDA_INVALID_NUTRIENTS');
      }
      const servingSize =
        typeof data.servingSize === 'number' && !Number.isNaN(data.servingSize)
          ? data.servingSize
          : undefined;
      const mayBePerServing =
        servingSize != null && servingSize > 0 && servingSize !== 100;
      return {
        description: String(data.description ?? '').trim(),
        nutrientsPer100g,
        ...(servingSize != null && { servingSize }),
        ...(mayBePerServing && { mayBePerServing: true }),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
