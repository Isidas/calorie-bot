import type { DishAnalysis } from '../types';
import type { ClarificationQuestion } from './dialog-state';

const DISH_KEYWORDS = ['cake', 'dessert', 'salad', 'pasta', 'sandwich'];

export function shouldAskClarification(analysis: DishAnalysis): boolean {
  if (analysis.confidence !== 'high') return true;
  const dishLower = analysis.dish.toLowerCase();
  return DISH_KEYWORDS.some((kw) => dishLower.includes(kw));
}

export function generateQuestion(analysis: DishAnalysis): ClarificationQuestion | null {
  const dishLower = analysis.dish.toLowerCase();
  if (dishLower.includes('cake') || dishLower.includes('dessert')) {
    return {
      id: 'cream',
      text: 'Есть ли крем или сливки?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }
  if (dishLower.includes('salad')) {
    return {
      id: 'sauce',
      text: 'Добавлено ли масло или майонез?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }
  return null;
}

export function applyCorrection(
  analysis: DishAnalysis,
  answer: string,
  questionId: string
): DishAnalysis {
  const isYes = answer.toLowerCase() === 'yes';
  let calFactor = 1;
  let fatFactor = 1;

  if (questionId === 'cream' && isYes) {
    calFactor = 1.25;
    fatFactor = 1.3;
  } else if (questionId === 'sauce' && isYes) {
    calFactor = 1.2;
    fatFactor = 1.25;
  }

  const calories = Math.round(analysis.calories * calFactor);
  const fat = Math.round(analysis.fat * fatFactor);
  const protein = analysis.protein;
  const carbs = analysis.carbs;
  const calories_range = {
    min: Math.round(analysis.calories_range.min * calFactor),
    max: Math.round(analysis.calories_range.max * calFactor),
  };

  return {
    ...analysis,
    calories,
    fat,
    protein,
    carbs,
    calories_range,
  };
}
