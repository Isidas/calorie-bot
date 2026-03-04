/** Диапазон калорий (мин–макс) */
export interface CaloriesRange {
  min: number;
  max: number;
}

/** Альтернативный вариант распознавания блюда */
export interface DishAlternative {
  dish: string;
  candidates: string[];
  confidence: 'low' | 'medium' | 'high';
}

/** Результат vision-анализа: блюдо и порция (без калорий) */
export interface DishVision {
  is_food: boolean;
  dish: string;
  portion_grams: number;
  portion_min: number;
  portion_max: number;
  candidates: string[];
  confidence: 'low' | 'medium' | 'high';
  alternatives: DishAlternative[];
}

/** Финальный результат анализа для бота */
export interface DishAnalysis {
  is_food: boolean;
  dish: string;
  weight_grams: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  calories_range: CaloriesRange;
  confidence: 'low' | 'medium' | 'high';
  assumptions: string[];
}

/** Результат загрузки фото: буфер и MIME-тип для корректной передачи в API */
export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageWithMime {
  buffer: Buffer;
  mimeType: ImageMimeType;
}

/** Провайдер vision: по фото возвращает блюдо и порцию; опционально — оценка БЖУ и перевод на русский */
export interface IVisionProvider {
  analyzeDishFromImage(imageBuffer: Buffer, mimeType?: ImageMimeType): Promise<DishVision>;
  estimateNutrition?(dish: string, portionGrams: number): Promise<EstimatedMacros>;
  /** Перевести короткую фразу на русский (например описание продукта из USDA) */
  translateToRussian?(text: string): Promise<string>;
}

/** Оценка БЖУ от Gemini (fallback при отсутствии в БД) */
export interface EstimatedMacros {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}
